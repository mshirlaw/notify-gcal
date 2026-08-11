const DEFAULT_LEAD_MINUTES = 1;

/**
 * Sends a typed message to the background service worker and awaits its response
 * @param {string} type - The message type the background worker handles
 * @returns {Promise<Object>} The response sent back by the background worker
 */
function sendMessageToBackground(type) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type }, resolve);
  });
}

/**
 * Displays a status message to the user with specified styling
 * @param {string} message - The message to display
 * @param {string} [type="info"] - The type of message (info, success, error)
 */
function showStatus(message, type = "info") {
  const statusDiv = document.getElementById("status");
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
}

/**
 * Clears the current status message
 */
function clearStatus() {
  const statusDiv = document.getElementById("status");
  statusDiv.textContent = "";
  statusDiv.className = "status";
}

/**
 * Updates the account status text and toggles the sign-in/sign-out buttons
 * @param {boolean} isSignedIn - Whether a Google account is currently connected
 */
function setSignedInView(isSignedIn) {
  const accountStatus = document.getElementById("accountStatus");
  const signInButton = document.getElementById("signInButton");
  const signOutButton = document.getElementById("signOutButton");

  accountStatus.textContent = isSignedIn ? "Connected to Google Calendar" : "Not signed in";
  signInButton.classList.toggle("hidden", isSignedIn);
  signOutButton.classList.toggle("hidden", !isSignedIn);
}

/**
 * Fetches the current sign-in status from the background worker and updates the view
 * @returns {Promise<void>}
 */
async function refreshAccountStatus() {
  const { signedIn } = await sendMessageToBackground("GET_STATUS");
  setSignedInView(signedIn);
}

/**
 * Populates the lead-time select with the value stored in sync storage
 * @returns {Promise<void>}
 */
async function loadLeadMinutes() {
  const { leadMinutes } = await chrome.storage.sync.get("leadMinutes");
  document.getElementById("leadMinutes").value = String(leadMinutes ?? DEFAULT_LEAD_MINUTES);
}

/**
 * Saves the lead-time select value to sync storage
 * @param {string} leadMinutes - The selected lead time, in minutes
 * @returns {Promise<void>}
 */
async function saveLeadMinutes(leadMinutes) {
  await chrome.storage.sync.set({ leadMinutes: Number(leadMinutes) });
}

/**
 * Handles a click on the sign-in button by starting the interactive OAuth flow
 * @returns {Promise<void>}
 */
async function handleSignInClick() {
  showStatus("Opening Google sign-in...", "info");
  const { ok, error } = await sendMessageToBackground("SIGN_IN");

  if (!ok) {
    showStatus(`Sign-in failed: ${error}`, "error");
    return;
  }

  clearStatus();
  await refreshAccountStatus();
}

/**
 * Handles a click on the sign-out button by revoking the connected account
 * @returns {Promise<void>}
 */
async function handleSignOutClick() {
  const { ok, error } = await sendMessageToBackground("SIGN_OUT");

  if (!ok) {
    showStatus(`Sign-out failed: ${error}`, "error");
    return;
  }

  showStatus("Signed out", "success");
  await refreshAccountStatus();
}

/**
 * Clears the list of today's events from the popup
 */
function clearTodaysEvents() {
  document.getElementById("todaysEvents").replaceChildren();
}

/**
 * Renders the list of today's remaining events in the popup
 * @param {Array<{ id: string, title: string, startLabel: string }>} events - Events to display
 */
function renderTodaysEvents(events) {
  const list = document.getElementById("todaysEvents");
  const items = events.map((event) => {
    const item = document.createElement("li");
    item.textContent = `${event.startLabel} - ${event.title}`;
    return item;
  });
  list.replaceChildren(...items);
}

/**
 * Handles a click on the check-now button by running an immediate calendar check
 * and displaying today's remaining events
 * @returns {Promise<void>}
 */
async function handleCheckNowClick() {
  showStatus("Checking calendar...", "info");
  const { ok, error, events } = await sendMessageToBackground("CHECK_NOW");

  if (!ok) {
    showStatus(`Check failed: ${error}`, "error");
    clearTodaysEvents();
    return;
  }

  showStatus(events.length ? `Checked, ${events.length} event(s) left today` : "Checked, no more events today", "success");
  renderTodaysEvents(events);
}

/**
 * Handles a change to the lead-time select by persisting the new value
 * @returns {Promise<void>}
 */
async function handleLeadMinutesChange() {
  await saveLeadMinutes(document.getElementById("leadMinutes").value);
}

/**
 * Initializes the popup by wiring up event listeners and loading current state
 * Called when the DOM content is loaded
 * @returns {Promise<void>}
 */
async function initializePopup() {
  document.getElementById("signInButton").addEventListener("click", handleSignInClick);
  document.getElementById("signOutButton").addEventListener("click", handleSignOutClick);
  document.getElementById("checkNowButton").addEventListener("click", handleCheckNowClick);
  document.getElementById("leadMinutes").addEventListener("change", handleLeadMinutesChange);

  await Promise.all([refreshAccountStatus(), loadLeadMinutes()]);
}

document.addEventListener("DOMContentLoaded", initializePopup);
