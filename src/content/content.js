// @ts-nocheck
// Helper function to get base URL
function getBaseURL(url) {
  const [baseUrl] = url?.split("?");
  return baseUrl;
}

// Initialize a global variable to store activity logs
let activityLogs = {};

// Visibility tracking variables
let initiallyVisibleElements = new Set();
let elementVisibilityMap = new Map(); // Maps element xpath to visibility info
let isPageLoaded = false;
let currentPageUrl = "";
let previousActions = []; // Store previous actions for reference in visible_from
let initializationTimeout = null;

// Critical event handling system
let recentCriticalEvents = new Map(); // For deduplication
const CRITICAL_EVENT_DEDUPE_TIME = 400; // ms - Increased for better deduplication
let recentEnterEvents = new Map(); // Separate tracking for Enter key events
const ENTER_EVENT_DEDUPE_TIME = 500; // ms - Increased to handle timing variations
let recentEnterForForm = null; // Track recent Enter events to coordinate with form submissions

// Function to detect if an element is navigational/critical
function isNavigationalElement(element) {
  if (!element) return false;

  const tagName = element.tagName?.toLowerCase();
  const type = element.type?.toLowerCase();
  const role = element.getAttribute("role")?.toLowerCase();

  // Primary navigational elements
  if (["button", "a"].includes(tagName)) return true;

  // Submit inputs
  if (tagName === "input" && type === "submit") return true;

  // Elements with button role
  if (role === "button") return true;

  // Elements with href
  if (element.hasAttribute("href")) return true;

  // Elements with onclick handlers
  if (element.onclick || element.getAttribute("onclick")) return true;

  // Search inputs (common navigation trigger)
if (
  (tagName === "input" || role === "search") &&
  (element.name?.toLowerCase().includes("search") ||
    element.placeholder?.toLowerCase().includes("search") ||
    element.id?.toLowerCase().includes("search"))
)
  return true;

  return false;
}

// Function to send critical events immediately
function sendCriticalEvent(eventData) {
  // DON'T include Date.now() in the key - this defeats deduplication!
  const similarEventKey = `${eventData.content}_${eventData.details?.xpath}`;
  const now = Date.now();

  // Check for recent duplicates
  for (const [key, timestamp] of recentCriticalEvents.entries()) {
    if (now - timestamp > CRITICAL_EVENT_DEDUPE_TIME) {
      recentCriticalEvents.delete(key);
    }
  }

  // Prevent duplicates
  let isDuplicate = false;
  for (const [key, timestamp] of recentCriticalEvents.entries()) {
    if (
      key.startsWith(similarEventKey) &&
      now - timestamp < CRITICAL_EVENT_DEDUPE_TIME
    ) {
      isDuplicate = true;
      break;
    }
  }

  if (isDuplicate) {

    return;
  }

  // Mark this event as sent - use the similarEventKey, not a unique timestamp
  recentCriticalEvents.set(similarEventKey, now);


  // Multiple immediate delivery attempts
  const sendAttempts = [0, 1, 5]; // 0ms, 1ms, 5ms delays

  sendAttempts.forEach((delay, index) => {
    setTimeout(() => {
      try {
        chrome.runtime?.sendMessage({
          ...eventData,
          critical: true,
          attempt: index + 1,
        });
      } catch (error) {
        
      }
    }, delay);
  });
}

// Clean up critical events tracking on page change
function cleanupCriticalEvents() {
  recentCriticalEvents.clear();
  recentEnterEvents.clear();
  recentEnterForForm = null;
  enterEventProcessing = false;
  navigationAttemptDetected = false;
}

// Add safety net for page unload
window.addEventListener("beforeunload", () => {
 
  cleanupCriticalEvents();
});

window.addEventListener("pagehide", () => {
  cleanupCriticalEvents();
});

// Function to send message to the background script
function sendMessageToPopup(message, callback) {
  chrome.runtime?.sendMessage(message, function (response) {
    if (callback && typeof callback === "function") {
      callback(response);
    }
  });
}

// Helper function to get XPath of an element
function getElementXPath0(element) {
  let path = "";
  while (element && element.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = element.previousSibling;
    while (sibling) {
      if (sibling.nodeName === element.nodeName) {
        index++;
      }
      sibling = sibling.previousSibling;
    }
    path = "/" + element.nodeName.toLowerCase() + path;
    element = element.parentNode;
  }
  return path || "/";
}

function getElementXPath(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const parts = [];

  while (element && element.nodeType === Node.ELEMENT_NODE) {
    const tagName = element.tagName.toLowerCase();

    // Special handling for html element - never needs index
    if (tagName === "html") {
      parts.unshift("html");
    } else {
      const parent = element.parentElement;
      if (!parent) {
        parts.unshift(tagName);
      } else {
        // Count siblings with the same tag name
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === element.tagName
        );

        if (siblings.length === 1) {
          // Only one element of this type - no index needed
          parts.unshift(tagName);
        } else {
          // Multiple siblings - find the position (1-based)
          const index = siblings.indexOf(element) + 1;
          parts.unshift(`${tagName}[${index}]`);
        }
      }
    }

    element = element.parentElement;
  }

  return "/" + parts.join("/");
}

// Helper function to check if element is visible
function isElementVisible(element) {
  if (!element) return false;

  const style = window.getComputedStyle(element);

  // Check if element is hidden by CSS
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();

  // Check if element has zero dimensions
  if (rect.width === 0 || rect.height === 0) {
    return false;
  }

  // Check if element is too large (takes up the entire viewport)
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  if (rect.width >= viewportWidth && rect.height >= viewportHeight) {
    return false;
  }

  // Check if element is in viewport
  return (
    rect.top <= viewportHeight &&
    rect.left <= viewportWidth &&
    rect.bottom >= 0 &&
    rect.right >= 0
  );
}

// Function to get all visible elements on the page
function getAllVisibleElements() {
  const allElements = document.querySelectorAll("*");
  const visibleElements = new Set();
  let checkedCount = 0;
  let visibleCount = 0;

  allElements.forEach((element) => {
    checkedCount++;
    if (isElementVisible(element)) {
      visibleCount++;
      const xpath = getElementXPath(element);
      visibleElements.add(xpath);
    }
  });

 
  return visibleElements;
}

// Function to clear memory when page changes
function clearVisibilityTracking() {
  initiallyVisibleElements.clear();
  elementVisibilityMap.clear();
  previousActions = [];
  isPageLoaded = false;
  if (initializationTimeout) {
    clearTimeout(initializationTimeout);
    initializationTimeout = null;
  }
  cleanupCriticalEvents(); // Also cleanup critical events
}

// Function to check if page URL has changed
function checkPageChange() {
  const newUrl = getBaseURL(window.location.href);
  if (currentPageUrl && currentPageUrl !== newUrl) {
    clearVisibilityTracking();
  }
  currentPageUrl = newUrl;
}

// Function to initialize visibility tracking on page load
function initializeVisibilityTracking() {
  if (isPageLoaded) return;

  // Clear any existing timeout
  if (initializationTimeout) {
    clearTimeout(initializationTimeout);
  }

  // Capture initial state immediately, then refine after a short delay
  try {
    initiallyVisibleElements = getAllVisibleElements();
    const currentURL = getBaseURL(window.location.href);

    // Initialize visibility map for initially visible elements
    initiallyVisibleElements.forEach((xpath) => {
      elementVisibilityMap.set(xpath, {
        type: "on_page",
        elementData: currentURL,
      });
    });

    isPageLoaded = true;
    

    // Refine the initial state after a short delay to catch any late-loading elements
    initializationTimeout = setTimeout(() => {
      const refinedVisibleElements = getAllVisibleElements();
      const newInitialElements = new Set();

      refinedVisibleElements.forEach((xpath) => {
        if (
          !initiallyVisibleElements.has(xpath) &&
          !elementVisibilityMap.has(xpath)
        ) {
          newInitialElements.add(xpath);
          initiallyVisibleElements.add(xpath);
          elementVisibilityMap.set(xpath, {
            type: "on_page",
            elementData: currentURL,
          });
        }
      });

      if (newInitialElements.size > 0) {
       
      }
    }, 200); // Much shorter delay for refinement
  } catch (error) {
    console.error("Error initializing visibility tracking:", error);
  }
}

// Function to track newly visible elements after an interaction
function trackNewlyVisibleElements(
  interactedElementData,
  actionType = "unknown"
) {
  if (!isPageLoaded) {

    return;
  }

  // Store this action for future reference
  const actionRecord = {
    timestamp: Date.now(),
    actionType: actionType,
    elementData: interactedElementData,
  };
  previousActions.push(actionRecord);

  // Keep only last 50 actions to manage memory
  if (previousActions.length > 50) {
    previousActions = previousActions.slice(-50);
  }

  // Small delay to let DOM updates happen
  setTimeout(() => {
    const currentVisibleElements = getAllVisibleElements();
    const newlyVisibleElements = new Set();

   

    // Find elements that are now visible but weren't initially visible
    currentVisibleElements.forEach((xpath) => {
      if (
        !initiallyVisibleElements.has(xpath) &&
        !elementVisibilityMap.has(xpath)
      ) {
        newlyVisibleElements.add(xpath);
        elementVisibilityMap.set(xpath, {
          type: "on_element",
          elementData: interactedElementData, // This is the element that caused visibility
        });
      }
    });

    if (newlyVisibleElements.size > 0) {
     
      newlyVisibleElements.forEach((xpath) => {
        
      });
    } else {
   
    }
  }, 50); // Small delay to catch DOM changes
}

// Function to get visibility info for an element
function getElementVisibilityInfo(element) {
  const xpath = getElementXPath(element);
  const visibilityInfo = elementVisibilityMap.get(xpath);

  // Only log for debugging - can be removed later
  if (Math.random() < 0.1) {
   
  }

  if (visibilityInfo) {
    return { visible_from: visibilityInfo };
  }

  // If not tracked but currently visible, check if it was initially visible
  if (isElementVisible(element)) {
    const currentURL = getBaseURL(window.location.href);

    // If element is in initially visible set, it's from page load
    if (initiallyVisibleElements.has(xpath)) {
      return {
        visible_from: {
          type: "on_page",
          elementData: currentURL,
        },
      };
    }

    // If page is loaded and element is not initially visible, it became visible due to interaction
    if (isPageLoaded) {
      // Try to find the most recent action that might have caused this
      if (previousActions.length > 0) {
        const lastAction = previousActions[previousActions.length - 1];
        // Add to tracking for future reference
        elementVisibilityMap.set(xpath, {
          type: "on_element",
          elementData: lastAction.elementData,
        });
       
        return {
          visible_from: {
            type: "on_element",
            elementData: lastAction.elementData,
          },
        };
      }
    }

    // Default to page load if we can't determine
    return {
      visible_from: {
        type: "on_page",
        elementData: currentURL,
      },
    };
  }

  // Default fallback for non-visible elements
  return {
    visible_from: {
      type: "on_page",
      elementData: getBaseURL(window.location.href),
    },
  };
}

// Initialize visibility tracking when DOM is ready with better timing
function setupVisibilityTracking() {
  checkPageChange();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeVisibilityTracking);
  } else {
    // Initialize immediately if DOM is already ready
    initializeVisibilityTracking();
  }
}

// Monitor for page changes and reinitialize
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
   
    setupVisibilityTracking();
  }
}).observe(document, { subtree: true, childList: true });

// Backup initialization on window load
window.addEventListener("load", () => {
  if (!isPageLoaded) {

    initializeVisibilityTracking();
  }
});

// Cleanup on page unload to prevent memory leaks
window.addEventListener("beforeunload", () => {
  clearVisibilityTracking();
});

// Additional safety layer: detect form submissions
document.addEventListener(
  "submit",
  (event) => {
    const now = Date.now();

    // If we just processed an Enter key within 100ms, skip form submission logging
    if (recentEnterForForm && now - recentEnterForForm < 100) {
     
      return;
    }



    const form = event.target;
    const currentURL = getBaseURL(window.location.href);

    // Try to get the submit button or the form itself
    const activeElement = document.activeElement;
    let elementOfInterest = form;
    if (form.contains(activeElement)) {
      elementOfInterest = activeElement;
    }
    const elementDetails = getElementData(elementOfInterest, window);

    const submitEventData = {
      content: "form_submit",
      details: elementDetails,
      url: currentURL,
      timestamp: Date.now(),
      triggerReason: "form_submission_likely_enter",
    };

    // Send only one critical event - remove multiple setTimeout calls
    sendCriticalEvent(submitEventData);

    trackNewlyVisibleElements(elementDetails.elementData, "form_submit");
  },
  true
);

// ULTIMATE SAFETY NET - Detect any navigation attempts
let navigationAttemptDetected = false;
const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

history.pushState = function (...args) {
 
  if (!navigationAttemptDetected) {
    navigationAttemptDetected = true;
    captureNavigationEvent("pushState");
  }
  return originalPushState.apply(this, args);
};

history.replaceState = function (...args) {

  if (!navigationAttemptDetected) {
    navigationAttemptDetected = true;
    captureNavigationEvent("replaceState");
  }
  return originalReplaceState.apply(this, args);
};

window.addEventListener("popstate", () => {
  
  captureNavigationEvent("popstate");
});

function captureNavigationEvent(method) {
 
  const activeElement = document.activeElement;
  if (activeElement) {
    try {
      const elementDetails = getElementData(activeElement, window);
      const emergencyEventData = {
        content: "emergency_navigation_capture",
        details: elementDetails,
        url: getBaseURL(window.location.href),
        timestamp: Date.now(),
        method: method,
      };

      // Emergency send
      sendCriticalEvent(emergencyEventData);
    } catch (error) {
      console.error("Error in emergency navigation capture:", error);
    }
  }
}



// Test Enter key detection
window.testEnterKeyDetection = function () {
 
};

// Initial setup
setupVisibilityTracking();

function getTopMostElement(elements) {
  return elements.reduce((topElement, currentElement) => {
    const topZIndex = parseInt(window.getComputedStyle(topElement).zIndex) || 0;
    const currentZIndex =
      parseInt(window.getComputedStyle(currentElement).zIndex) || 0;

    return currentZIndex > topZIndex ? currentElement : topElement;
  });
}

function getVisibleElementAtPoint(elements, x, y) {
  // Filter elements that are actually visible at the point
  return elements.find((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    // Check if element is visible and not hidden
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    );
  });
}

function getTopMostVisibleElement(elements, x, y) {
  // First filter by visibility and bounds (Method 5)
  const visibleElements = elements.filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      style.pointerEvents !== "none" &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    );
  });

  // Then find the one that's actually on top using DOM position and z-index
  return visibleElements.reduce((topElement, currentElement) => {
    // If one contains the other, the contained one is on top
    if (topElement.contains(currentElement)) return currentElement;
    if (currentElement.contains(topElement)) return topElement;

    // Compare z-index within same stacking context
    const topZIndex = parseInt(window.getComputedStyle(topElement).zIndex) || 0;
    const currentZIndex =
      parseInt(window.getComputedStyle(currentElement).zIndex) || 0;

    if (currentZIndex !== topZIndex) {
      return currentZIndex > topZIndex ? currentElement : topElement;
    }

    // Same z-index: later in DOM wins
    return topElement.compareDocumentPosition(currentElement) &
      Node.DOCUMENT_POSITION_FOLLOWING
      ? currentElement
      : topElement;
  });
}

const getClassName = (element) => {
  try {
    // If className is an object (like SVGAnimatedString)
    if (typeof element.className === "object") {
      // Try baseVal first (common in SVG elements)
      if (element.className.baseVal !== undefined) {
        return element.className.baseVal;
      }
      // If it's another type of object, convert to string
      return element.className.toString();
    }
    // Regular string className
    return element.className || "";
  } catch (e) {
    // Fallback if any error occurs
    return "";
  }
};

// Optimized version that searches within visible elements from point first
function getElementsWithSameCenterOptimized(targetX, targetY, tolerance = 2) {
  const elementsWithSameCenter = [];

  // Start with elements at the point and their ancestors/descendants
  const elementsAtPoint = document.elementsFromPoint(targetX, targetY);
  const candidateElements = new Set();

  // Add elements at point and their related elements
  elementsAtPoint.forEach((element) => {
    candidateElements.add(element);

    // Add parent elements
    let parent = element.parentElement;
    while (parent) {
      candidateElements.add(parent);
      parent = parent.parentElement;
    }

    // Add child elements
    const children = element.querySelectorAll("*");
    children.forEach((child) => candidateElements.add(child));
  });

  // Check each candidate element
  candidateElements.forEach((element) => {
    if (!isElementVisible(element)) return;

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const elementCenterX = rect.left + rect.width / 2;
    const elementCenterY = rect.top + rect.height / 2;

    const xMatch = Math.abs(elementCenterX - targetX) <= tolerance;
    const yMatch = Math.abs(elementCenterY - targetY) <= tolerance;

    if (xMatch && yMatch) {
      // Extract non-empty attributes
      let typedValue;
      let elementData = {};
      for (const attr of element.attributes) {
        if (attr.value && attr.value.trim() !== "") {
          // const key = attr.name.replace(/-([a-z])/g, (_, g) => g.toUpperCase());
          elementData[attr.name] = attr.value.trim();
        }
      }
      elementData.tagName = element.tagName.toLowerCase();

      if (element.value) {
        typedValue = element.value;
        elementData.value = typedValue;
      } else if (element.innerText) {
        typedValue = element.innerText;
        elementData.innerText = typedValue;
      } else if (element.textContent) {
        typedValue = element.textContent;
        elementData.textContent = typedValue;
      } else if (element.data) {
        typedValue = element.data;
        elementData.data = typedValue;
      }

      elementsWithSameCenter.push({
        element: element,
        centerX: elementCenterX,
        centerY: elementCenterY,
        rect: rect,
        xpath: getElementXPath(element),
        elementData: elementData,
        typedValue: typedValue,
      });
    }
  });

  return elementsWithSameCenter;
}

// Add this at the top of your file
let lastEventTime = 0;
let lastEventTarget = null;
const DEBOUNCE_DELAY = 300; // milliseconds

// Early mousedown listener for critical elements (before regular click handling)
document.addEventListener(
  "mousedown",
  (event) => {
    checkPageChange();

    const element = event.target;
    const isNavigational = isNavigationalElement(element);

    if (isNavigational) {
    

      // Get element details immediately
      const elementDetails = getElementData(element, window);
      const currentURL = getBaseURL(window.location.href);

      // Send critical event immediately
      const criticalEventData = {
        content: "clicked",
        details: elementDetails,
        url: currentURL,
        timestamp: Date.now(),
      };

      sendCriticalEvent(criticalEventData);

      // Track newly visible elements
      trackNewlyVisibleElements(elementDetails.elementData, "critical_click");
    }
  },
  true
); // Use capture phase for earliest detection

// Listen for click events
["mousedown", "click", "pointerdown"].forEach((eventType) => {
  document.addEventListener(
    eventType,
    (event) => {
      // Check for page changes
      checkPageChange();

      const currentTime = Date.now();

      // Skip if same target clicked within debounce delay
      if (
        event.target === lastEventTarget ||
        currentTime - lastEventTime < DEBOUNCE_DELAY
      ) {
        return;
      }

      // Update tracking variables
      lastEventTime = currentTime;
      lastEventTarget = event.target;


      const xpath = getElementXPath(event.target);
      const rect = event.target.getBoundingClientRect();
      const currentURL = getBaseURL(window.location.href);

      // Get x and y coordinates of the click
      const x = event.clientX;
      const y = event.clientY;

      // Get all elements at the clicked coordinates and keep only the innermost visible one
      let visibleElements = document
        .elementsFromPoint(x, y)
        .filter((el) => isElementVisible(el));

      

      // Keep only the innermost element (first element is topmost in the stack)
      // const elementsAtPoint = visibleElements.length > 0 ?
      //   [{ element: visibleElements[0] }] : [];
      const elementsAtPoint = visibleElements;


      // Use let instead of const to allow reassignment
      let elementDetails;
      let ElementOfInterest;

      if (event.target === visibleElements[0]) {
        ElementOfInterest = event.target;
      } else {
        const topMostElement = getTopMostVisibleElement(visibleElements, x, y);
     
        ElementOfInterest = topMostElement;
      }

      elementDetails = getElementData(ElementOfInterest, window);

      elementDetails.same_center_elements = getElementsWithSameCenterOptimized(
        elementDetails.x,
        elementDetails.y
      );

      // Track newly visible elements after this interaction
      trackNewlyVisibleElements(elementDetails.elementData, "click");

      if (!activityLogs[currentURL]) {
        activityLogs[currentURL] = [];
      }

      activityLogs[currentURL].push({
        activity: "clicked",
        xpath: xpath,
        x: x + window.scrollX,
        y: y + window.scrollY,
        elementsAtPoint: elementsAtPoint,
      });

      // Check if this is a critical element and send immediately if so
      const isNavigational = isNavigationalElement(ElementOfInterest);
      const eventData = {
        content: "clicked",
        details: elementDetails,
        url: currentURL,
      };

      if (isNavigational) {
        sendCriticalEvent(eventData);
      }

      sendMessageToPopup(eventData, function (response) {
      });
    },
    true
  );
});

// Listen for input events (typing in textareas and inputs)
document.addEventListener("input", (event) => {
  // Check for page changes
  checkPageChange();

    const target = event.composedPath().length
      ? event.composedPath()[0]
      : event.target;
    const targetTagName = target.tagName;

    if (
      target && "inputType" in event &&
      (targetTagName === "INPUT" ||
        targetTagName === "TEXTAREA" ||
        targetTagName === "SELECT" ||
        target.isContentEditable)
    ) {

    const xpath = getElementXPath(target);
    const rect = target.getBoundingClientRect();

    // Get coordinates of the input element
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // Get all elements at these coordinates and keep only the innermost visible one
    let visibleElements = document
      .elementsFromPoint(x, y)
      .filter((el) => isElementVisible(el));

    // Keep only the innermost element (first element is topmost in the stack)
    const elementsAtPoint =
      visibleElements.length > 0 ? [{ element: visibleElements[0] }] : [];

    // Use let instead of const to allow reassignment
    let elementDetails;
    let ElementOfInterest = target;

    elementDetails = getElementData(ElementOfInterest, window);
    const typedValue =
      elementDetails.typedValue || ElementOfInterest.value || "";

    // Track newly visible elements after this interaction
    trackNewlyVisibleElements(elementDetails.elementData, "input");

    const currentURL = getBaseURL(window.location.href);

    if (!activityLogs[currentURL]) {
      activityLogs[currentURL] = [];
    }

    activityLogs[currentURL].push({
      activity: "typed",
      xpath: xpath,
      value: typedValue,
      x: x + window.scrollX,
      y: y + window.scrollY,
      elementsAtPoint: elementsAtPoint,
      inputValue: typedValue,
      trackedInput: event.data,
    });


    // Check if this is a critical input (like search) and send immediately
    const isNavigational = isNavigationalElement(ElementOfInterest);
    const inputEventData = {
      content: "typed",
      details: elementDetails,
      url: currentURL,
      inputValue: typedValue,
      trackedInput: typedValue,
    };

    if (isNavigational) {
      sendCriticalEvent(inputEventData);
    }

    sendMessageToPopup(inputEventData, function (response) {
    });
  }
});

// Single, comprehensive Enter key listener with processing flag
let enterEventProcessing = false;

document.addEventListener(
  "keydown",
  (event) => {
    // Check for page changes
    checkPageChange();

    // Handle Enter key IMMEDIATELY - with deduplication
    if (event.key === "Enter" && !enterEventProcessing) {
      enterEventProcessing = true;
      // Process immediately
      handleEnterKeyImmediately(event);

      // Reset flag after short delay
      setTimeout(() => {
        enterEventProcessing = false;
      }, 100);

      return; // Exit early after handling Enter
    }
  },
  true
); // Use capture phase for earliest possible detection

// Function to handle Enter key with maximum urgency
function handleEnterKeyImmediately(event) {
  const target = event.target || document.activeElement || document.body;
  const currentURL = getBaseURL(window.location.href);
  const xpath = getElementXPath(target);
  const now = Date.now();

  // Track this Enter event for form submission coordination
  recentEnterForForm = now;

  // Dedicated Enter key deduplication
  if (recentEnterEvents.has(xpath)) {
    const lastEnter = recentEnterEvents.get(xpath);
    if (now - lastEnter < ENTER_EVENT_DEDUPE_TIME) {
      return;
    }
  }

  // Record this Enter event
  recentEnterEvents.set(xpath, now);

  // Cleanup old Enter events
  for (const [key, timestamp] of recentEnterEvents.entries()) {
    if (now - timestamp > ENTER_EVENT_DEDUPE_TIME * 2) {
      recentEnterEvents.delete(key);
    }
  }

  try {
    // Get element details immediately
    const elementDetails = getElementData(target, window);
    const typedValue = elementDetails.typedValue || target.value || "";

    const enterEventData = {
      content: "enter",
      details: elementDetails,
      url: currentURL,
      inputValue: typedValue,
      timestamp: Date.now(),
      urgentCapture: true,
    };

    // Send through critical system ONLY for navigational elements
    const isNavigational = isNavigationalElement(target);
    if (isNavigational) {
      sendCriticalEvent(enterEventData);
    } else {
      // For non-critical elements, use regular system only
      sendMessageToPopup(enterEventData, function (response) {
      });
    }

    // Track newly visible elements
    trackNewlyVisibleElements(elementDetails.elementData, "enter");

    // Log activity
    if (!activityLogs[currentURL]) {
      activityLogs[currentURL] = [];
    }

    const rect = target.getBoundingClientRect();

    activityLogs[currentURL].push({
      activity: "enter",
      xpath: xpath,
      value: typedValue,
      x: rect.left + rect.width / 2 + window.scrollX,
      y: rect.top + rect.height / 2 + window.scrollY,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Error handling Enter key:", error);
  }
}

// Multiple backup listeners removed - now using single consolidated listener above
// This eliminates the race conditions and duplicate events caused by multiple listeners

// Legacy keydown listener removed - replaced by optimized handlers above

function isInteractableElementOptimized(element, rect, style) {
  // Quick size check
  if (rect.width === 0 || rect.height === 0) return false;

  // Quick visibility check
  if (style.display === "none" || style.visibility === "hidden") return false;

  const tagName = element.tagName;

  // Primary interactive elements
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tagName)) {
    return true;
  }

  // Check for interactive roles
  const role = element.getAttribute("role");
  if (
    [
      "button",
      "link",
      "checkbox",
      "radio",
      "tab",
      "menuitem",
      "combobox",
    ].includes(role)
  ) {
    return true;
  }

  // Text elements that might contain important info
  if (
    ["H1", "H2", "H3", "H4", "H5", "H6", "P", "SPAN", "LI"].includes(tagName)
  ) {
    // Only include if they have meaningful text and aren't too large
    const text = element.textContent?.trim() || "";
    if (text.length > 0 && text.length < 200) {
      const area = rect.width * rect.height;
      const viewportArea = window.innerWidth * window.innerHeight;
      return area / viewportArea < 0.9; // Not covering most of viewport
    }
  }

  return false;
}

// create function that take ElementOfInterest and return elementData
function getElementData(ElementOfInterest, window) {
  let elementDetails = {
    element: ElementOfInterest,
    xpath: getElementXPath(ElementOfInterest),
    className: getClassName(ElementOfInterest),
    id: ElementOfInterest.id,
    tagName: ElementOfInterest.tagName.toLowerCase(),
    ariaLabel: ElementOfInterest.getAttribute("aria-label") || null,
    dataCy: ElementOfInterest.getAttribute("data-cy") || null,
    name: ElementOfInterest.getAttribute("name") || null,
    placeholder: ElementOfInterest.getAttribute("placeholder") || null,
    title: ElementOfInterest.getAttribute("title") || null,
    role: ElementOfInterest.getAttribute("role") || null,
    href: ElementOfInterest.getAttribute("href") || null,
    type: ElementOfInterest.getAttribute("type") || null,
    textContent: ElementOfInterest.textContent
      ? ElementOfInterest.textContent.trim()
      : null,
    x:
      ElementOfInterest.getBoundingClientRect().left +
      ElementOfInterest.getBoundingClientRect().width / 2,
    y:
      ElementOfInterest.getBoundingClientRect().top +
      ElementOfInterest.getBoundingClientRect().height / 2,
    left: ElementOfInterest.getBoundingClientRect().left,
    top: ElementOfInterest.getBoundingClientRect().top,
    width: ElementOfInterest.getBoundingClientRect().width,
    height: ElementOfInterest.getBoundingClientRect().height,
    pageXOffset:
      window.scrollX ||
      window.pageXOffset ||
      document.documentElement.scrollLeft ||
      document.body.scrollLeft ||
      0,
    pageYOffset:
      window.scrollY ||
      window.pageYOffset ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0,
    scrollX:
      window.scrollX ||
      window.pageXOffset ||
      document.documentElement.scrollLeft ||
      document.body.scrollLeft ||
      0,
    scrollY:
      window.scrollY ||
      window.pageYOffset ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    ...getElementVisibilityInfo(ElementOfInterest),
    nested_element: Array.from(ElementOfInterest.children).map((child) => {
      // Extract non-empty attributes for child element
      let childElementData = {};
      for (const attr of child.attributes) {
        if (attr.value && attr.value.trim() !== "") {
          childElementData[attr.name] = attr.value.trim();
        }
      }
      childElementData.tagName = child.tagName.toLowerCase();

      // Add value/text content to child elementData
      if (child.value) {
        childElementData.value = child.value;
      } else if (child.innerText) {
        childElementData.innerText = child.innerText;
      } else if (child.textContent) {
        childElementData.textContent = child.textContent;
      } else if (child.data) {
        childElementData.data = child.data;
      }

      if (child.textContent) {
        childElementData.textContent = child.textContent;
      }

      return {
        xpath: getElementXPath(child),
        element: child,
        className: getClassName(child),
        id: child.id,
        tagName: child.tagName.toLowerCase(),
        ariaLabel: child.getAttribute("aria-label") || null,
        dataCy: child.getAttribute("data-cy") || null,
        name: child.getAttribute("name") || null,
        placeholder: child.getAttribute("placeholder") || null,
        title: child.getAttribute("title") || null,
        role: child.getAttribute("role") || null,
        href: child.getAttribute("href") || null,
        type: child.getAttribute("type") || null,
        textContent: child.textContent ? child.textContent.trim() : null,
        x:
          child.getBoundingClientRect().left +
          child.getBoundingClientRect().width / 2,
        y:
          child.getBoundingClientRect().top +
          child.getBoundingClientRect().height / 2,
        left: child.getBoundingClientRect().left,
        top: child.getBoundingClientRect().top,
        width: child.getBoundingClientRect().width,
        height: child.getBoundingClientRect().height,
        elementData: childElementData,
      };
    }),
    same_level_elements: (() => {
      if (!ElementOfInterest.parentElement) return [];

      return Array.from(ElementOfInterest.parentElement.children)
        .filter(
          (sibling) =>
            sibling !== ElementOfInterest &&
            isInteractableElementOptimized(
              sibling,
              sibling.getBoundingClientRect(),
              window.getComputedStyle(sibling)
            )
        ) // Exclude the element itself
        .map((sibling) => {
          const siblingRect = sibling.getBoundingClientRect();
          const siblingStyle = window.getComputedStyle(sibling);

          // Build elementData for sibling
          const siblingElementData = {
            tagName: sibling.tagName.toLowerCase(),
          };

          // Collect sibling attributes efficiently
          const siblingAttrs = sibling.attributes;
          for (let i = 0; i < siblingAttrs.length; i++) {
            const attr = siblingAttrs[i];
            if (attr.value && attr.value.trim() !== "") {
              siblingElementData[attr.name] = attr.value.trim();
            }
          }

          // Add special properties for sibling
          if (sibling.value) {
            siblingElementData.value = sibling.value;
          } else if (sibling.innerText) {
            siblingElementData.innerText = sibling.innerText;
          } else if (sibling.textContent) {
            siblingElementData.textContent = sibling.textContent;
          } else if (sibling.data) {
            siblingElementData.data = sibling.data;
          }

          return {
            x: Math.round((siblingRect.left + siblingRect.right) / 2),
            y: Math.round((siblingRect.top + siblingRect.bottom) / 2),
            left: Math.round(siblingRect.left),
            top: Math.round(siblingRect.top),
            width: Math.round(siblingRect.width),
            height: Math.round(siblingRect.height),
            tagName: sibling.tagName ? sibling.tagName.toLowerCase() : null,

            // Interactability properties for sibling elements
            is_enabled: !sibling.disabled,
            is_visible: !(
              siblingStyle.display === "none" ||
              siblingStyle.visibility === "hidden" ||
              siblingStyle.opacity === "0"
            ),
            is_clickable: (() => {
              const elementAtPoint = document.elementFromPoint(
                siblingRect.left + siblingRect.width / 2,
                siblingRect.top + siblingRect.height / 2
              );
              return (
                sibling.contains(elementAtPoint) || sibling === elementAtPoint
              );
            })(),

            className: sibling.getAttribute("class") || null,
            ariaLabel: sibling.getAttribute("aria-label") || null,
            dataCy: sibling.getAttribute("data-cy") || null,
            name: sibling.getAttribute("name") || null,
            placeholder: sibling.getAttribute("placeholder") || null,
            title: sibling.getAttribute("title") || null,
            role: sibling.getAttribute("role") || null,
            href: sibling.getAttribute("href") || null,
            type: sibling.getAttribute("type") || null,
            textContent: sibling.textContent
              ? sibling.textContent.trim()
              : null,
            element_text:
              Array.from(sibling.childNodes)
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.nodeValue)
                .join("")
                .trim() || null,

            elementData: siblingElementData,
          };
        });
    })(),
  };

  // Extract non-empty attributes
  let typedValue;
  let elementData = {};
  for (const attr of ElementOfInterest.attributes) {
    if (attr.value && attr.value.trim() !== "") {
      // const key = attr.name.replace(/-([a-z])/g, (_, g) => g.toUpperCase());
      elementData[attr.name] = attr.value;
    }
  }
  elementData.tagName = ElementOfInterest.tagName.toLowerCase();

  // if (ElementOfInterest.value) {
  //   typedValue = ElementOfInterest.value;
  //   elementData.value = typedValue;

if (ElementOfInterest.value !== undefined) {
  typedValue = ElementOfInterest.value;
  elementData.value = typedValue;
} else if (ElementOfInterest.innerText) {
  typedValue = ElementOfInterest.innerText;
  elementData.innerText = typedValue;
} else if (ElementOfInterest.textContent) {
  typedValue = ElementOfInterest.textContent;
  elementData.textContent = typedValue;
} else if (ElementOfInterest.data) {
  typedValue = ElementOfInterest.data;
  elementData.data = typedValue;
}
  elementDetails.elementData = elementData;
  elementDetails.typedValue = typedValue;
  return elementDetails;
}
