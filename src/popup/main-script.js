/** @format */

import crypto from "crypto-browserify";

// State management
let recordingState = "start"; // "start", "recording", "paused"
let focusedEventId = null;
let savedSessions = [];
let isRecording = false;
let screenshotData = [];
let logData = {};
let jsonData = { session_data: [] };
let typingTimer;
const doneTypingInterval = 1;
let stepCounter = 1;
let initialURLSet = false;
// Events array in the format you requested
let events = [];
let dashboardView = "activity";
const RECORDING_STATES = ["start", "recording", "paused"];
let chatDemoStarted = false;
let chatMessageDelivered = false;
let chatReplyTimer = null;

function setRecordingState(nextState) {
  if (!RECORDING_STATES.includes(nextState)) {
    return;
  }

  recordingState = nextState;
  isRecording = nextState === "recording";
  updateRecordingButton();
  updateEmptyState();
  updateSessionHero();
}

function updateSessionHero() {
  const hero = document.getElementById("sessionHero");
  const dashboardBody = document.getElementById("dashboardBody");
  if (!hero || !dashboardBody) return;

  const shouldShowHero = recordingState === "start" && events.length === 0;
  hero.classList.toggle("is-visible", shouldShowHero);
  hero.setAttribute("aria-hidden", shouldShowHero ? "false" : "true");
  dashboardBody.setAttribute("aria-hidden", shouldShowHero ? "true" : "false");
}

function startChatDemoSequence() {
  if (chatDemoStarted || chatMessageDelivered) return;
  const thread = document.getElementById("chatThread");
  if (!thread) return;

  chatDemoStarted = true;
  chatReplyTimer = setTimeout(() => {
    const targetThread = document.getElementById("chatThread");
    if (!targetThread) return;

    const typingBubble = targetThread.querySelector(".chat-message.typing");
    if (typingBubble) typingBubble.remove();

    targetThread.insertAdjacentHTML(
      "beforeend",
      `
        <div class="chat-message incoming">
          <div class="chat-avatar">
            <span>✶</span>
          </div>
          <div class="chat-bubble">
            <p>Hello, how can I assist you?</p>
            <span class="chat-timestamp">Just now</span>
          </div>
        </div>
      `
    );
    chatMessageDelivered = true;
  }, 1500);
}
function captureScreenshot(step_id, x = 0, y = 0) {
  chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      console.error(
        "Screenshot capture failed:",
        chrome.runtime.lastError.message
      );
      return;
    }

    if (dataUrl) {

      screenshotData.push({
        step_id,
        x,
        y,
        img_binary: dataUrl,
      });
    } else {
      console.warn("No screenshot captured for step", step_id);
    }
  });
}
// Function to add event to events array
function addEvent(type, element, input = null, x = 0, y = 0) {
  if (!isRecording) return null;

  // Create new event
  const event = {
    id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(
      36
    )}`,
    step_id: stepCounter,
    type: type,
    path: element.xpath, // Use the extracted name
    element: element, // Store the full element data
    step_type: "act",
    timestamp: new Date(),
    input,
  };

  events.push(event);
  captureScreenshot(stepCounter, x, y);
  stepCounter++;
  updateEventCount();
  renderEvents();
  return event;
}
function updateLastTypedEvent(element, newInput) {
  const lastEvent = events[events.length - 1];
  if (
    lastEvent &&
    lastEvent.type === "TYPED" &&
    lastEvent.path === element.xpath
  ) {
    lastEvent.input = newInput;

    const inputSpan = document.querySelector(
      `#event-card-${lastEvent.id} .log-input`
    );
    if (inputSpan) {
      inputSpan.textContent = newInput;
    }
  }
}

// Function to update empty state visibility
function updateEmptyState() {
  const container = document.getElementById("eventsContainer");
  if (!container) return;

  const hasEvents = events.length > 0;
  const saveBtn = document.getElementById("saveBtn");
  const clearBtn = document.getElementById("clearBtn");

  container.classList.toggle("is-empty", !hasEvents);

  if (!hasEvents) {
    if (recordingState === "start") {
      container.innerHTML = "";
    } else {
      container.innerHTML = `
        <div class="capture-hint">
          Click your active tab to log each step in real time.
        </div>
      `;
    }
  }

  [saveBtn, clearBtn].forEach((btn) => {
    if (btn) {
      btn.disabled = !hasEvents;
      btn.classList.toggle("disabled-btn", !hasEvents);
    }
  });

  updateSessionHero();
}
function areElementDataIdentical(elementData1, elementData2) {
  if (!elementData1 && !elementData2) return true;
  if (!elementData1 || !elementData2) return false;

  // Get all unique keys from both objects
  const keys1 = Object.keys(elementData1);
  const keys2 = Object.keys(elementData2);
  const allKeys = new Set([...keys1, ...keys2]);

  // Compare each key
  for (const key of allKeys) {
    if (elementData1[key] !== elementData2[key]) {


      // Skip dynamic content keys that might change between interactions
      const skipKeys = ["value", "innerText", "textContent", "data"];
      if (skipKeys.includes(key)) {

        continue;
      }


      return false;
    }
  }

  return true;
}

// Helper function to check if two entries are the same
function areEntriesIdentical(entry1, entry2) {
  if (!entry1 || !entry2) return false;



  // Compare basic properties
  if (
    entry1.action !== entry2.action ||
    entry1.url !== entry2.url ||
    entry1.element.xpath !== entry2.element.xpath
  ) {

    return false;
  }

  // For typed and enter actions, also compare keyboard input
  // if ((entry1.action === 'typed' || entry1.action === 'enter')
  //       // && entry1.keyboard_input !== entry2.keyboard_input
  //   ) {
  //   return false;
  // }

  // Compare elementData objects
  if (
    !areElementDataIdentical(
      entry1.element?.elementData,
      entry2.element?.elementData
    )
  ) {

    return false;
  }

  return true;
}

// Helper function to safely push entry to jsonData if it's not a duplicate
function pushEntryToJsonData(entry) {
  const lastEntry = jsonData.session_data[jsonData.session_data.length - 1];

  if (!areEntriesIdentical(entry, lastEntry)) {
    jsonData.session_data.push(entry);
    return true; // Entry was added
  }

  return false; // Entry was skipped
}

// Function to store and update logs
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only process messages when recording is active
  if (!isRecording) {
    sendResponse({ status: "not_recording" });
    return;
  }

  const currentURL = message.url;
  if (!initialURLSet && currentURL) {
    addInitialNavigateEvent(currentURL);
    initialURLSet = true;
  }
  // Initialize log data for the current URL if it doesn't exist
  if (!logData[currentURL]) {
    logData[currentURL] = [];
  }

  if (message.content === "clicked") {
    const logEntry = {
      url: currentURL,
      action: "click",
      element: message.details,
    };

    const jsonEntry = {
      step_id: stepCounter,
      url: currentURL,
      action: "click",
      element: message.details,
    };

    // Only push to logData if jsonData push was successful (not a duplicate)
    if (pushEntryToJsonData(jsonEntry)) {
      logData[currentURL].push(logEntry);

      const output = document.getElementById("eventsContainer");
      if (output) {
        // Remove empty state if it exists
        const emptyState = output.querySelector(".empty-state");
        if (emptyState) {
          output.innerHTML = "";
        }

        addEvent(
          "CLICK",
          logEntry.element,
          null,
          message.details.x,
          message.details.y
        );
        output.scrollTop = output.scrollHeight;
      }
    }

    sendResponse({ status: "received" });
  }

  // Handle typed
  if (message.content === "typed") {
    const logEntry = {
      url: currentURL,
      action: "typed",
      keyboard_input: message.inputValue,
      element: message.details,
    };

    const lastEvent = events[events.length - 1];

    // Check if the last event was a TYPED event on the same element
    if (
      lastEvent &&
      lastEvent.type === "TYPED" &&
      lastEvent.path === message.details.xpath
    ) {
      // Update the last event instead of creating a new one
      updateLastTypedEvent(message.details, message.inputValue);

      // also update the jsonData
      const lastJsonEntry =
        jsonData.session_data[jsonData.session_data.length - 1];
      if (
        lastJsonEntry &&
        lastJsonEntry.action === "typed" &&
        lastJsonEntry.element.xpath === message.details.xpath
      ) {
        lastJsonEntry.keyboard_input = message.inputValue;
      }
    } else {
      // Create a new event if the last event was different
      const jsonEntry = {
        step_id: stepCounter,
        url: currentURL,
        action: "typed",
        keyboard_input: message.inputValue,
        element: { ...message.details },
      };

      if (pushEntryToJsonData(jsonEntry)) {
        logData[currentURL].push(logEntry);
        const output = document.getElementById("eventsContainer");
        if (output) {
          const emptyState = output.querySelector(".empty-state");
          if (emptyState) output.innerHTML = "";

          addEvent(
            "TYPED",
            message.details,
            message.inputValue,
            message.details.x,
            message.details.y
          );
          output.scrollTop = output.scrollHeight;
        }
      }
    }

    sendResponse({ status: "received" });
  }

  // Handle enter
  if (message.content === "enter") {
    const logEntry = {
      url: currentURL,
      action: "enter",
      keyboard_input: message.inputValue,
      element: message.details,
    };



    // Add to structured JSON format
    const jsonEntry = {
      step_id: stepCounter,
      url: currentURL,
      action: "enter",
      keyboard_input: message.inputValue,
      element: {
        ...message.details,
      },
    };

    // Only push to logData if jsonData push was successful (not a duplicate)
    if (pushEntryToJsonData(jsonEntry)) {
      logData[currentURL].push(logEntry);

      // Display the log data in the popup
      const output = document.getElementById("eventsContainer");
      if (output) {
        // Remove empty state if it exists
        const emptyState = output.querySelector(".empty-state");
        if (emptyState) {
          output.innerHTML = "";
        }

        addEvent(
          "ENTER",
          message.details,
          null,
          message.details.x,
          message.details.y
        );
        output.scrollTop = output.scrollHeight;
      }
    }

    sendResponse({ status: "received" });
  }
});

// Utility functions to access the events data
function getEvents() {
  return events;
}

function getEventById(id) {
  return events.find((event) => event.id === id);
}

function getEventsByType(type) {
  return events.filter((event) => event.type === type);
}

// Show confirmation modal
function showConfirmationModal() {
  const modal = document.getElementById("confirmationModal");
  if (modal) modal.classList.add("active");
}

// Hide confirmation modal
function hideConfirmationModal() {
  const modal = document.getElementById("confirmationModal");
  if (modal) modal.classList.remove("active");
}

// Clear data on confirmation
document.getElementById("confirmAction")?.addEventListener("click", () => {
  clearEvents(); // your existing reset logic
  hideConfirmationModal(); // close modal
});

// Cancel discard
document
  .getElementById("cancelAction")
  ?.addEventListener("click", hideConfirmationModal);

function addInitialNavigateEvent(url) {
  const currentURL = url;
  let cleanedURL = "No active tab found";

  if (currentURL) {
    try {
      const urlObject = new URL(currentURL);
      cleanedURL = urlObject.hostname.replace(/^www\./, "");
    } catch (error) {
      console.warn("Invalid URL:", currentURL);
      cleanedURL = currentURL; // Fallback to the original URL if parsing fails
    }
  }

  if (events.length === 0) {
    const initialEvent = {
      id: `${Date.now().toString(36)}${Math.floor(
        Math.random() * 1000
      ).toString(36)}`,
      step_id: stepCounter,
      type: "NAVIGATE",
      path: cleanedURL, // Use the cleaned URL
      element: { xpath: cleanedURL }, // Create an element-like object for navigation
      step_type: "act",
      timestamp: new Date(),
    };
    events.unshift(initialEvent); // Add to the beginning of the array

    // Also add it to the session data
    const jsonEntry = {
      step_id: stepCounter,
      url: currentURL, // Save the full URL in the session data
      action: "navigate",
      step_type: "act",
      element: null, // No element for navigation
      timestamp: new Date(),
    };
    jsonData.session_data.unshift(jsonEntry);

    stepCounter++;
  }

  renderEvents();
  updateEventCount();
}

function clearEvents() {
  events = [];
  logData = {};
  jsonData = { session_data: [] };
  screenshotData = [];
  stepCounter = 1;
  focusedEventId = null;
  setRecordingState("start");
  initialURLSet = false;

  updateEventCount();
}

// Initialize the app
function init() {
  updateEmptyState();

  updateRecordingButton();

  const userAvatarBtn = document.getElementById("user-avatar");
  const userNameElem = document.getElementById("user-name");
  const userEmailElem = document.getElementById("user-email");

  // Get all chrome local storage data
  chrome.storage.local.get(null, function (result) {


    const userName = result.userName || "Guest";
    const userEmail = result.userEmail || "user@example.com";
    const userPhoto = result.userPhoto || null; // save photoURL in storage earlier

    // Set name & email
    if (userNameElem) userNameElem.textContent = userName;
    if (userEmailElem) userEmailElem.textContent = userEmail;

    // Set avatar (photoURL if available, else default SVG)
    if (userAvatarBtn) {
      if (userPhoto) {
        userAvatarBtn.innerHTML = `<img src="${userPhoto}" alt="User" class="avatar-img" />`;
      } else {
        userAvatarBtn.innerHTML = `
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        `;
      }
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener("click", function (event) {
    const dropdown = document.getElementById("userDropdown");
    if (dropdown && !dropdown.contains(event.target)) {
      dropdown.classList.remove("active");
    }
  });

  // Close modal when clicking overlay
  const saveModal = document.getElementById("saveModal");
  if (saveModal) {
    saveModal.addEventListener("click", function (event) {
      if (event.target === this) {
        handleModalClose();
      }
    });
  }
}

// Recording button handler
function handleRecordingClick() {
  switch (recordingState) {
    case "start":
      setRecordingState("recording");
      break;
    case "recording":
      setRecordingState("paused");
      break;
    case "paused":
      setRecordingState("recording");
      break;
  }
}

// Update recording button appearance
function updateRecordingButton() {
  const icon = document.getElementById("recordingIcon");
  const text = document.getElementById("recordingText");

  if (!icon || !text) return;

  switch (recordingState) {
    case "start":
      icon.innerHTML = '<circle cx="12" cy="12" r="10"/>';
      text.textContent = "Start Session";
      break;
    case "recording":
      icon.innerHTML =
        '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
      text.textContent = "Pause Session";
      break;
    case "paused":
      icon.innerHTML = '<polygon points="5,3 19,12 5,21"/>';
      text.textContent = "Resume Session";
      break;
  }
}

// Event card click handler
function handleCardClick(eventId) {
  focusedEventId = focusedEventId === eventId ? null : eventId;
  renderEvents();
}

// Delete event handler - Complete implementation
function handleDeleteEventByStepId(stepId) {


  // Convert to number if needed
  const stepIdNum = parseInt(stepId, 10);

  // Remove from `events`
  events = events.filter((event) => event.step_id !== stepIdNum);

  // Remove from `jsonData.session_data`
  jsonData.session_data = jsonData.session_data.filter(
    (item) => item.step_id !== stepIdNum
  );

  // Remove from `logData` across all URLs
  Object.keys(logData).forEach((url) => {
    logData[url] = logData[url].filter((item) => item.step_id !== stepIdNum);
  });

  // Remove from `screenshotData`
  screenshotData = screenshotData.filter((item) => item.step_id !== stepIdNum);

  // Reset focusedEventId if the deleted one had the same step_id
  if (focusedEventId) {
    const focusedEvent = events.find((e) => e.id === focusedEventId);
    if (focusedEvent && focusedEvent.step_id === stepIdNum) {
      focusedEventId = null;
    }
  }

  // Re-render UI
  renderEvents();
  updateEventCount();
  updateEmptyState();


}

function setCloseCancelDisabled(isDisabled) {
  const closeBtn = document.getElementById("closeBtn");
  const cancelBtn = document.getElementById("cancelBtn");

  if (closeBtn) closeBtn.disabled = isDisabled;
  if (cancelBtn) cancelBtn.disabled = isDisabled;

  // Optional: add visual feedback
  [closeBtn, cancelBtn].forEach((btn) => {
    if (btn) {
      if (isDisabled) {
        btn.classList.add("disabled-btn");
      } else {
        btn.classList.remove("disabled-btn");
      }
    }
  });
}
// Save button click handler
function handleSaveClick() {
  const saveModal = document.getElementById("saveModal");
  if (saveModal) {
    saveModal.classList.add("active");
    hideSessionError();
    updateModalEventCount();
  }
}
function setSaving(isSaving) {
  const saveBtn = document.getElementById("saveSessionBtn");
  const defaultText = saveBtn.querySelector(".default-text");
  const loadingText = saveBtn.querySelector(".loading-text");

  if (isSaving) {
    saveBtn.disabled = true;
    setCloseCancelDisabled(true);
    defaultText.style.display = "none";
    loadingText.style.display = "inline";
  } else {
    saveBtn.disabled = false;
    setCloseCancelDisabled(false);
    defaultText.style.display = "inline";
    loadingText.style.display = "none";
  }
}
const VERSION = Buffer.from([0x80]);
const TOKEN_TTL = 60 * 60;

function deriveKeyFromToken(accessToken) {
  const ENCRYPTION_SALT = "g5!>L$A->0y6VV?l%`n&B3E9jyC4!:";
  const ENCRYPTION_ITERATIONS = 98434;

  const publicPart = accessToken.substring(10, 22);
  const privatePart = accessToken.substring(15, 27);
  const keyMaterial = Buffer.from(publicPart + privatePart, "utf-8");

  const salt = Buffer.from(ENCRYPTION_SALT, "utf-8");

  const derivedKey = crypto.pbkdf2Sync(
    keyMaterial,
    salt,
    ENCRYPTION_ITERATIONS,
    32,
    "sha256"
  );

  // Python returns base64url padded string
  return derivedKey
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .padEnd(44, "=");
}

function encryptJsonString(jsonData, keyB64) {
  const key = Buffer.from(
    keyB64.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );

  const signingKey = key.slice(0, 16);
  const encryptionKey = key.slice(16, 32);

  const iv = crypto.randomBytes(16);
  const jsonString = JSON.stringify(jsonData);
  const timestamp = Buffer.alloc(8);
  const seconds = Math.floor(Date.now() / 1000);
  timestamp.writeBigUInt64BE(BigInt(seconds));

  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(jsonString, "utf8")),
    cipher.final(),
  ]);

  const body = Buffer.concat([VERSION, timestamp, iv, ciphertext]);
  const hmac = crypto.createHmac("sha256", signingKey).update(body).digest();

  const token = Buffer.concat([body, hmac]).toString("base64");
  return token.replace(/\+/g, "-").replace(/\//g, "_");
}
async function handleSaveSession() {
  hideSessionError(); // Clear previous errors
  setSaving(true);

  const progressContainer = document.getElementById("progressContainer");
  const progressBar = document.getElementById("progressBar");
  const percentage = document.getElementById("progressText");
  progressContainer.style.display = "block";
  progressBar.style.width = "0%";
  percentage.textContent = "0%";

  let { accessToken, refreshToken } = await new Promise((resolve) => {
    chrome.storage.local.get(["accessToken", "refreshToken"], (result) => {
      resolve(result);
    });
  });
  const key = deriveKeyFromToken(accessToken);
  const sessionName = document.getElementById("sessionName").value.trim();

  if (!sessionName) {
    setSaving(false);
    showSessionError("Session name is required");
    progressContainer.style.display = "none";
    return;
  }

  if (savedSessions.includes(sessionName)) {
    setSaving(false);
    showSessionError("A session with this name already exists locally");
    progressContainer.style.display = "none";
    return;
  }

  const encryptedData = encryptJsonString(jsonData.session_data, key);
  const payload = {
    session_name: sessionName,
    data: encryptedData,
  };

  try {
    let response = await fetch(
      `http://141.148.221.8:8000/save-chrome-session`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      }
    );
    if (
      response.msg == "Token has expired" ||
      (response.status === 401 && refreshToken)
    ) {
      console.warn("Access token expired. Trying refresh...");

      const refreshRes = await fetch("http://141.148.221.8:8000/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${refreshToken}`,
        },
        body: JSON.stringify({ device_type: "chrome_extension" }),
      });

      if (!refreshRes.ok) {
        console.error("Refresh failed. Logging out.");
        chrome.storage.local.clear(() => {

        });
        chrome.identity.clearAllCachedAuthTokens(() => {

          window.location.replace("./popup.html?relogin=true");
        });
        return;
      }

      const tokens = await refreshRes.json();
      await new Promise((resolve) => {
        chrome.storage.local.set({ accessToken: tokens.access_token }, () => {
          resolve();
        });
      });
      accessToken = tokens.access_token;

      //  Retry original request with new token
      response = await fetch(`http://141.148.221.8:8000/save-chrome-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });
    }

    const result = await response.json();

    // Handle errors
    if (!response.ok) {
      if (result && result.error) {
        setSaving(false);
        showSessionError(result.error);
      } else {
        setSaving(false);
        showSessionError("Failed to save session. Please try again.");
      }
      progressContainer.style.display = "none";
      return;
    }


    savedSessions.push(sessionName);

    // ⬇️ Start uploading screenshots one by one
    const sessionId = result.session_id;
    const totalImages = screenshotData.length;
    let uploadedImages = 1;

    for (const imageData of screenshotData) {
      try {
        const imagePayload = {
          session_id: sessionId,
          step_id: imageData.step_id,
          x: imageData.x,
          y: imageData.y,
          img_binary: imageData.img_binary,
        };

        await fetch(`http://141.148.221.8:8000/save-image`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(imagePayload),
        });

        uploadedImages++;
        const progress = (uploadedImages / totalImages) * 100;
        const roundedProgress = Math.round(progress);
        progressBar.style.width = `${roundedProgress}%`;
        percentage.textContent = roundedProgress + "%";


        if (progress === 100) {
          setTimeout(() => {
            handleModalClose();
          }, 5000); // Close modal 0.5s after completion
        }
      } catch (imageErr) {
        console.warn(
          `Failed to save image for step ${imageData.step_id}`,
          imageErr
        );
      }
    }

    // Optional: Download
    // const downloadData = JSON.stringify(jsonData, null, 2);
    // const blob = new Blob([downloadData], { type: "application/json" });
    // const link = document.createElement("a");
    // link.href = URL.createObjectURL(blob);
    // link.download = `${sessionName}.json`;
    // link.click();

    setSaving(false);
    handleModalClose();
  } catch (err) {
    setSaving(false);
    console.error(" Error saving session:", err);
    showSessionError("Something went wrong. Please try again.");
  } finally {
    // Ensure the progress bar is hidden even if there's an error
    if (progressContainer) {
      progressContainer.style.display = "none";
    }
  }
}

// Modal close handler
function handleModalClose() {
  const saveModal = document.getElementById("saveModal");
  const sessionNameInput = document.getElementById("sessionName");
  const progressContainer = document.getElementById("progressContainer");

  if (saveModal) {
    saveModal.classList.remove("active");
  }

  if (sessionNameInput) {
    sessionNameInput.value = "";
  }
  if (progressContainer) {
    progressContainer.style.display = "none";
  }

  hideSessionError();
}

// Utility functions
function getEventIcon(type) {
  switch (type) {
    case "CLICK":
      return '<rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/>';
    case "TYPED":
      return '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>';
    case "ENTER":
      return '<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>';
    case "NAVIGATE":
      return '<circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />';
    default:
      return '<rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/>';
  }
}

function getElementName(event) {
  const nameEntityList = [
    "textContent",
    "innerText",
    "ariaLabel",
    "aria-label",
    "name",
    "placeholder",
    "text",
    "value",
    "data",
    "href",
    "title",
    "tagName",
    "type",
  ];

  if (event.element && event.element.elementData) {
    for (const nameEntity of nameEntityList) {
      if (
        event.element.elementData.hasOwnProperty(nameEntity) &&
        event.element.elementData[nameEntity] !== "" &&
        event.element.elementData[nameEntity] !== null
      ) {
        return event.element.elementData[nameEntity];
      }
    }
  }
  return event.path;
}

function renderEvents() {
  const container = document.getElementById("eventsContainer");
  const saveBtn = document.getElementById("saveBtn");
  const clearBtn = document.getElementById("clearBtn");

  if (!container) return;

  if (events.length === 0) {
    updateEmptyState();
    return;
  }

  container.innerHTML = "";
  [saveBtn, clearBtn].forEach((btn) => {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("disabled-btn");
    }
  });
  events.forEach((event, index) => {
    const eventCard = document.createElement("div");
    eventCard.id = `event-card-${event.id}`;
    eventCard.className = `event-card ${
      focusedEventId === event.id ? "focused" : ""
    }`;
    eventCard.onclick = () => handleCardClick(event.id);

    const inputSection = event.input
      ? `
        <div class="log-detail">
          <span class="log-label">Input:</span>
          <span class="log-value log-input">${event.input}</span>
        </div>
      `
      : "";

    const elementName = getElementName(event);
    const truncatedPath =
      elementName.length > 10
        ? elementName.substring(0, 10) + "..."
        : elementName;

    eventCard.innerHTML = `
      <div class="event-card-content">
        <div class="event-card-flex">
          <div class="event-step-number">${index + 1}</div>
          <div class="event-icon">
            <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${getEventIcon(event.type)}
            </svg>
          </div>
          <div class="event-details">
            <div class="event-meta">
              <div class="event-type-badge">${event.type}</div>
              <span class="event-path" title="${
                event.path
              }">${truncatedPath}</span>
            </div>
            ${inputSection}
          </div>
          ${
            index !== 0
              ? `
              <button class="delete-btn" data-step="${event.step_id}" title="Delete this event">
                <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3,6 5,6 21,6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  <line x1="10" y1="11" x2="10" y2="17"/>
                  <line x1="14" y1="11" x2="14" y2="17"/>
                </svg>
              </button>
            `
              : ""
          }
        </div>
      </div>
    `;

    container.appendChild(eventCard);
  });

  // Set delete listeners after DOM is ready
  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const stepId = btn.getAttribute("data-step");
      handleDeleteEventByStepId(stepId);
    });
  });

  updateSessionHero();
}

function updateEventCount() {
  const eventCountElement = document.getElementById("eventCount");
  if (eventCountElement) {
    eventCountElement.textContent = events.length;
  }
  updateSaveButtonState();
}
function updateSaveButtonState() {
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) {
    const hasEvents = events.length > 0;
    saveBtn.disabled = !hasEvents;

    // Add visual styling for disabled state
    if (hasEvents) {
      saveBtn.classList.remove("disabled");
      saveBtn.title = "Save session";
    } else {
      saveBtn.classList.add("disabled");
      saveBtn.title = "Record at least one interaction to save";
    }
  }
}
function updateModalEventCount() {
  const modalEventCountElement = document.getElementById("modalEventCount");
  if (modalEventCountElement) {
    modalEventCountElement.textContent = events.length;
  }
}

function showSessionError(message) {
  const errorElement = document.getElementById("sessionError");
  const errorText = document.getElementById("sessionErrorText");
  const input = document.getElementById("sessionName");

  if (errorElement && errorText && input) {
    errorText.textContent = message;
    errorElement.style.display = "flex";
    input.classList.add("error");
  }
}

function hideSessionError() {
  const errorElement = document.getElementById("sessionError");
  const input = document.getElementById("sessionName");

  if (errorElement && input) {
    errorElement.style.display = "none";
    input.classList.remove("error");
  }
}

function setDashboardView(view) {
  const activityPanel = document.getElementById("activityView");
  const chatPanel = document.getElementById("chatView");
  const toggleButtons = document.querySelectorAll(".view-toggle .toggle-btn");

  if (!activityPanel || !chatPanel || !toggleButtons.length) {
    dashboardView = "activity";
    return;
  }

  dashboardView = view === "chat" ? "chat" : "activity";
  const showingChat = dashboardView === "chat";

  activityPanel.classList.toggle("is-active", !showingChat);
  activityPanel.setAttribute("aria-hidden", showingChat ? "true" : "false");
  chatPanel.classList.toggle("is-active", showingChat);
  chatPanel.setAttribute("aria-hidden", showingChat ? "false" : "true");

  toggleButtons.forEach((button) => {
    const isActive = button.dataset.view === dashboardView;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  if (document?.body) {
    document.body.classList.toggle("chat-mode", showingChat);
  }

  if (showingChat) {
    startChatDemoSequence();
  }
}

// Logout handler
function handleLogout() {
  // Clear stored tokens (access + refresh)
  chrome.storage.local.clear(() => {

  });
  // 🔄 Clear Chrome Identity token
  chrome.identity.clearAllCachedAuthTokens(() => {


    // Redirect to login screen or popup
    window.location.replace("./popup.html");
  });
}
// Event listeners setup
document.addEventListener("DOMContentLoaded", function () {
  // Initialize the app when page loads
  init();

  // Save button
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", handleSaveClick);
  }

  // Close button
  const closeBtn = document.getElementById("closeBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", handleModalClose);
  }

  // Cancel button
  const cancelBtn = document.getElementById("cancelBtn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", handleModalClose);
  }

  // Logout button
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", handleLogout);
  }

  // Recording button
  const recordingBtn = document.getElementById("recordingBtn");
  if (recordingBtn) {
    recordingBtn.addEventListener("click", handleRecordingClick);
  }

  // Clear events button
  const clearBtn = document.getElementById("clearBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", showConfirmationModal);
  }

  // Save session button
  const saveSessionBtn = document.getElementById("saveSessionBtn");
  if (saveSessionBtn) {
    saveSessionBtn.addEventListener("click", handleSaveSession);
  }

  // Dropdown toggle
  const userDropdown = document.getElementById("userDropdown");
  if (userDropdown) {
    userDropdown.addEventListener("click", function () {
      this.classList.toggle("active");
    });
  }

  // Clear error when typing
  const sessionNameInput = document.getElementById("sessionName");
  if (sessionNameInput) {
    sessionNameInput.addEventListener("input", function () {
      if (this.value.trim()) {
        hideSessionError();
      }
    });
  }

  const toggleButtons = document.querySelectorAll(".view-toggle .toggle-btn");
  if (toggleButtons.length) {
    toggleButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const { view } = button.dataset;
        if (view && view !== dashboardView) {
          setDashboardView(view);
        }
      });
    });
    setDashboardView(dashboardView);
  }

  const chatBackBtn = document.getElementById("chatBackBtn");
  if (chatBackBtn) {
    chatBackBtn.addEventListener("click", () => setDashboardView("activity"));
  }

  const heroStartBtn = document.getElementById("heroStartBtn");
  if (heroStartBtn) {
    heroStartBtn.addEventListener("click", () => setRecordingState("recording"));
  }
});

// Export functions for external use
window.EventLogger = {
  getEvents,
  getEventById,
  getEventsByType,
  // clearEvents,
  addEvent,
  events: () => events,
  recordingState: () => recordingState,
  isRecording: () => isRecording,
  setRecordingState,
};
