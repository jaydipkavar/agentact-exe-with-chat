
// Global flag to prevent multiple authentication attempts
let authInProgress = false;
let authCompleted = false;

// -------------------- Auto login --------------------
(async function checkLoginStatus() {
  const urlParams = new URLSearchParams(window.location.search);
  const relogin = urlParams.get("relogin");

  if (relogin) {
    await startAuth();
    return;
  }

  chrome.storage.local.get(["accessToken", "refreshToken"], async (result) => {
    let accessToken = result.accessToken;
    const refreshToken = result.refreshToken;

    if (accessToken) {

      window.location.replace("./main.html");
      return;
    }

    if (refreshToken) {
      try {
       const refreshRes = await fetch("http://141.148.221.8:8000/refresh", {
         method: "POST",
         headers: {
           "Content-Type": "application/json",
           Authorization: `Bearer ${refreshToken}`,
         },
         body: JSON.stringify({ device_type: "chrome_extension" }),
       });

        if (!refreshRes.ok) throw new Error("Refresh failed");

        const data = await refreshRes.json();

        await new Promise((resolve) =>
          chrome.storage.local.set(
            {
              accessToken: data.access_token,
              refreshToken: data.refresh_token,
            },
            resolve
          )
        );


        window.location.replace("./main.html");
      } catch (err) {
        console.error("Refresh token invalid or expired:", err);
        chrome.storage.local.clear();
        window.location.replace("./popup.html");
      }
    }
  });
})();

// -------------------- Google Sign-in Button --------------------
const googleButton = document.querySelector(".btn__google");

// Remove any existing event listeners and add only one
if (googleButton) {
  // Clone the button to remove all existing event listeners
  const newButton = googleButton.cloneNode(true);
  googleButton.parentNode.replaceChild(newButton, googleButton);

  // Add single event listener to the new button
  newButton.addEventListener("click", handleGoogleSignIn);
}

/**
 * Handle Google Sign-in button click - with multiple protection layers
 */
async function handleGoogleSignIn(event) {
  // Prevent event bubbling and default behavior
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();



  // Multiple layers of protection against duplicate calls
  if (authInProgress) {

    return;
  }

  if (authCompleted) {

    return;
  }

  // Immediately disable the button and set flags
  const currentButton = document.querySelector(".btn__google");
  if (currentButton) {
    currentButton.disabled = true;
    currentButton.style.pointerEvents = "none";
  }

  authInProgress = true;

  const buttonText = currentButton?.querySelector(".button-text");
  const loader = currentButton?.querySelector(".loader");



  // Update UI to show loading state
  updateButtonUI(true, buttonText, loader, currentButton);

  try {
    await startAuth();
    authCompleted = true;
  } catch (error) {

    // Reset flags on error to allow retry
    authInProgress = false;
    updateButtonUI(false, buttonText, loader, currentButton);
  }
}

/**
 * Update button UI state
 */
function updateButtonUI(loading, buttonText, loader, button) {
  if (!button) return;

  if (loading) {
    if (buttonText) buttonText.style.display = "none";
    if (loader) loader.style.display = "inline-block";
    button.disabled = true;
    button.style.pointerEvents = "none";
  } else {
    if (buttonText) buttonText.style.display = "flex";
    if (loader) loader.style.display = "none";
    button.disabled = false;
    button.style.pointerEvents = "auto";
  }
}

/**
 * Start Chrome Identity + Firebase Auth + backend login API
 * Now with singleton pattern to prevent multiple executions
 */
let authPromise = null;

async function startAuth() {
  // Return existing promise if auth is already in progress
  if (authPromise) {

    return authPromise;
  }



  authPromise = new Promise((resolve, reject) => {
    let tokenProcessed = false;

    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      // Prevent multiple executions of this callback
      if (tokenProcessed) {

        return;
      }
      tokenProcessed = true;

      if (chrome.runtime.lastError || !token) {
        console.warn(
          "Chrome identity token error:",
          chrome.runtime.lastError?.message
        );
        authPromise = null; // Reset promise on error
        reject(
          new Error(
            chrome.runtime.lastError?.message || "Failed to get auth token"
          )
        );
        return;
      }

      try {


        // Single backend call: /login with additional headers to prevent caching
        const response = await fetch(`http://141.148.221.8:8000/chrome-login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "X-Timestamp": Date.now().toString(),
          },
          body: JSON.stringify({ idToken:token }),
        });

        if (!response.ok) {
          const text = await response.text();
          console.warn("Backend login failed:", response.status, text);
          authPromise = null; // Reset promise on error
          throw new Error(`Backend login failed: ${response.status}`);
        }

        const data = await response.json();


        // Store tokens and user info
        await new Promise((storageResolve) =>
          chrome.storage.local.set(
            {
              accessToken: data.access_token,
              refreshToken: data.refresh_token,
              userName: data.name || "",
              userEmail: data.email || "",
              userPhoto: data.picture || "",
            },
            storageResolve
          )
        );


        // Small delay to ensure everything is saved before redirect
        setTimeout(() => {
          window.location.replace("./main.html");
        }, 100);

        resolve();
      } catch (error) {
        console.warn(
          "Login flow error:",
          error.code || error.message || error
        );
        authPromise = null; // Reset promise on error
        reject(error);
      }
    });
  });

  return authPromise;
}
