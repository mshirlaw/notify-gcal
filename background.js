const CHECK_ALARM_NAME = "check-events";
const DEFAULT_LEAD_MINUTES = 1;
const NOTIFIED_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_PERIOD_MINUTES = 0.5;

/**
 * Logs a debug message to the service worker console, prefixed for easy filtering
 * @param {...*} args - Values to log
 */
function logDebug(...args) {
  console.log("[Notify GCal]", ...args);
}

/**
 * Creates (or resets) the recurring alarm that triggers calendar checks
 * Chrome normally floors alarm periods at 1 minute, but relaxes that for unpacked (dev-mode)
 * extensions, so this can run twice a minute to cut worst-case notification lag in half
 */
function createCheckAlarm() {
  chrome.alarms.create(CHECK_ALARM_NAME, { periodInMinutes: CHECK_PERIOD_MINUTES });
}

/**
 * Requests an OAuth token for the signed-in Google account
 * @param {boolean} interactive - Whether to show a sign-in prompt if no token is cached
 * @returns {Promise<string>} The OAuth access token
 */
function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError ?? new Error("No token returned"));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * Removes a token from Chrome's local cache so the next request fetches a fresh one
 * @param {string} token - The token to remove from the cache
 * @returns {Promise<void>}
 */
function clearCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

/**
 * Revokes a token with Google so the account is fully signed out
 * @param {string} token - The token to revoke
 * @returns {Promise<void>}
 */
async function revokeToken(token) {
  await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
}

/**
 * Reads the user's configured notification lead time
 * @returns {Promise<number>} Minutes before an event start to notify
 */
async function getLeadMinutes() {
  const { leadMinutes } = await chrome.storage.sync.get("leadMinutes");
  return leadMinutes ?? DEFAULT_LEAD_MINUTES;
}

/**
 * Reads the map of event IDs that have already triggered a notification
 * @returns {Promise<Object<string, number>>} Map of event ID to the timestamp it was notified
 */
async function getNotifiedEventIds() {
  const { notifiedEventIds } = await chrome.storage.local.get("notifiedEventIds");
  return notifiedEventIds ?? {};
}

/**
 * Persists the map of notified event IDs
 * @param {Object<string, number>} notifiedEventIds - Map of event ID to notified timestamp
 * @returns {Promise<void>}
 */
async function saveNotifiedEventIds(notifiedEventIds) {
  await chrome.storage.local.set({ notifiedEventIds });
}

/**
 * Removes expired entries from a notified-events map
 * @param {Object<string, number>} notifiedEventIds - Map of event ID to notified timestamp
 * @returns {Object<string, number>} A new map containing only entries within the TTL window
 */
function pruneNotifiedEventIds(notifiedEventIds) {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(notifiedEventIds).filter(([, notifiedAt]) => now - notifiedAt < NOTIFIED_EVENT_TTL_MS),
  );
}

/**
 * Builds a Calendar API events.list URL for a given time window
 * @param {Date} timeMin - The earliest event start time to include
 * @param {Date} timeMax - The latest event start time to include
 * @returns {URL} The events.list request URL
 */
function buildEventsUrl(timeMin, timeMax) {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin.toISOString());
  url.searchParams.set("timeMax", timeMax.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  return url;
}

/**
 * Fetches events from the Calendar API for a given time window
 * @param {string} token - The OAuth access token
 * @param {Date} timeMin - The earliest event start time to include
 * @param {Date} timeMax - The latest event start time to include
 * @returns {Promise<Array<Object>>} The matching calendar events
 */
async function fetchEvents(token, timeMin, timeMax) {
  const response = await fetch(buildEventsUrl(timeMin, timeMax), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    await clearCachedToken(token);
    throw new Error("Auth token expired, cleared cache");
  }

  if (!response.ok) {
    throw new Error(`Calendar API error: ${response.status}`);
  }

  const { items } = await response.json();
  return items ?? [];
}

/**
 * Fetches events starting within the configured lead-time window
 * @param {string} token - The OAuth access token
 * @param {number} leadMinutes - Minutes ahead of now to include in the search window
 * @returns {Promise<Array<Object>>} The upcoming calendar events
 */
async function fetchUpcomingEvents(token, leadMinutes) {
  return fetchEvents(token, new Date(), new Date(Date.now() + (leadMinutes + 1) * 60 * 1000));
}

/**
 * Fetches the remaining events on today's calendar, regardless of lead time
 * @param {string} token - The OAuth access token
 * @returns {Promise<Array<Object>>} Today's remaining calendar events
 */
async function fetchTodaysRemainingEvents(token) {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return fetchEvents(token, new Date(), endOfToday);
}

/**
 * Formats an event into a plain object the popup can render, without exposing the full API resource
 * @param {Object} event - A Calendar API event resource
 * @returns {{ id: string, title: string, startLabel: string }} The display-ready summary
 */
function summarizeEventForDisplay(event) {
  return {
    id: event.id,
    title: event.summary || "(No title)",
    startLabel: event.start?.dateTime ? formatEventStartTime(event.start.dateTime) : "All day",
  };
}

/**
 * Fetches a single event by ID
 * @param {string} eventId - The Calendar event ID
 * @param {string} token - The OAuth access token
 * @returns {Promise<Object|null>} The event, or null if it could not be fetched
 */
async function fetchEventById(eventId, token) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    return null;
  }

  return response.json();
}

/**
 * Determines whether an event falls inside the "notify now" window
 * @param {Object} event - A Calendar API event resource
 * @param {number} leadMinutes - Minutes ahead of the start time to notify
 * @returns {boolean} True if the event should be notified now
 */
function isEventStartingSoon(event, leadMinutes) {
  const start = event.start?.dateTime;
  if (!start) {
    return false;
  }
  const msUntilStart = new Date(start).getTime() - Date.now();
  return msUntilStart <= leadMinutes * 60 * 1000 && msUntilStart > -60 * 1000;
}

/**
 * Formats an ISO date-time string as a short local time
 * @param {string} dateTime - An ISO 8601 date-time string
 * @returns {string} The formatted time, e.g. "14:05"
 */
function formatEventStartTime(dateTime) {
  return new Date(dateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Finds an event's video call link, covering Google Meet and other conferencing providers
 * @param {Object} event - A Calendar API event resource
 * @returns {string|null} The video call URL, or null if the event has none
 */
function getVideoConferenceLink(event) {
  if (event.hangoutLink) {
    return event.hangoutLink;
  }
  const videoEntryPoint = event.conferenceData?.entryPoints?.find((entryPoint) => entryPoint.entryPointType === "video");
  return videoEntryPoint?.uri ?? null;
}

/**
 * Builds the options object for a Chrome notification representing an event
 * @param {Object} event - A Calendar API event resource
 * @returns {chrome.notifications.NotificationOptions} The notification options
 */
function buildNotificationOptions(event) {
  const startTime = formatEventStartTime(event.start.dateTime);
  return {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: event.summary || "(No title)",
    message: `Starts at ${startTime}${event.location ? ` · ${event.location}` : ""}`,
    contextMessage: "Google Calendar",
    priority: 2,
    requireInteraction: true,
    buttons: getVideoConferenceLink(event) ? [{ title: "Join Meeting" }] : [],
  };
}

/**
 * Ensures the offscreen document used for sound playback exists, creating it if needed
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
  const hasDocument = await chrome.offscreen.hasDocument();
  if (hasDocument) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play a sound when a calendar event is about to start",
  });
}

/**
 * Plays a notification sound via the offscreen document
 * @returns {Promise<void>}
 */
async function playNotificationSound() {
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({ target: "offscreen", type: "PLAY_SOUND" });
}

/**
 * Shows a native notification for an event, logging the outcome for debugging
 * @param {Object} event - A Calendar API event resource
 */
function showEventNotification(event) {
  logDebug("Creating notification for event", event.id, event.summary, "video link:", getVideoConferenceLink(event));
  chrome.notifications.create(event.id, buildNotificationOptions(event), (notificationId) => {
    if (chrome.runtime.lastError) {
      logDebug("Notification creation failed for", event.id, chrome.runtime.lastError.message);
      return;
    }
    logDebug("Notification created with id", notificationId);
  });
  playNotificationSound().catch((error) => logDebug("Failed to play notification sound:", error.message));
}

/**
 * Opens an event's video call link, falling back to its Calendar page
 * @param {Object} event - A Calendar API event resource
 */
function openEventLink(event) {
  const link = getVideoConferenceLink(event) || event.htmlLink;
  if (link) {
    chrome.tabs.create({ url: link });
  }
}

/**
 * Logs why a single event was or wasn't notified during a check
 * @param {Object} event - A Calendar API event resource
 * @param {number} leadMinutes - Minutes ahead of the start time to notify
 * @param {boolean} alreadyNotified - Whether this event ID was already marked as notified
 */
function logEventDecision(event, leadMinutes, alreadyNotified) {
  const start = event.start?.dateTime;
  const msUntilStart = start ? new Date(start).getTime() - Date.now() : null;

  if (alreadyNotified) {
    logDebug("Skipping (already notified):", event.summary, event.id);
    return;
  }
  if (!start) {
    logDebug("Skipping (no start dateTime, likely all-day):", event.summary, event.id);
    return;
  }
  if (!isEventStartingSoon(event, leadMinutes)) {
    logDebug(
      "Skipping (outside lead window):",
      event.summary,
      `${Math.round(msUntilStart / 1000)}s until start`,
      `lead is ${leadMinutes}m`,
    );
    return;
  }
  logDebug("Will notify:", event.summary, `${Math.round(msUntilStart / 1000)}s until start`);
}

/**
 * Fetches upcoming events and shows a notification for each one not yet notified
 * @returns {Promise<void>}
 */
async function checkUpcomingEvents() {
  const token = await getAuthToken(false);
  const leadMinutes = await getLeadMinutes();
  const events = await fetchUpcomingEvents(token, leadMinutes);
  const notifiedEventIds = pruneNotifiedEventIds(await getNotifiedEventIds());

  logDebug(`Checking ${events.length} event(s) with a ${leadMinutes}m lead time`);
  events.forEach((event) => logEventDecision(event, leadMinutes, Boolean(notifiedEventIds[event.id])));

  for (const event of events) {
    if (notifiedEventIds[event.id] || !isEventStartingSoon(event, leadMinutes)) {
      continue;
    }
    showEventNotification(event);
    notifiedEventIds[event.id] = Date.now();
  }

  await saveNotifiedEventIds(notifiedEventIds);
}

/**
 * Handles a click on an event notification by opening its meeting link
 * @param {string} notificationId - The Calendar event ID used as the notification ID
 * @returns {Promise<void>}
 */
async function handleNotificationClick(notificationId) {
  const token = await getAuthToken(false).catch(() => null);
  if (!token) {
    return;
  }
  const event = await fetchEventById(notificationId, token);
  if (event) {
    openEventLink(event);
  }
}

/**
 * Handles the alarm firing by running a calendar check, logging any failure
 * @param {chrome.alarms.Alarm} alarm - The alarm that fired
 * @returns {Promise<void>}
 */
async function handleAlarm(alarm) {
  if (alarm.name !== CHECK_ALARM_NAME) {
    return;
  }
  try {
    await checkUpcomingEvents();
  } catch (error) {
    console.error("Notify GCal: check failed", error);
  }
}

/**
 * Handles a SIGN_IN request from the popup by starting the interactive OAuth flow
 * @param {function(Object): void} sendResponse - Callback to reply to the popup
 * @returns {Promise<void>}
 */
async function handleSignInMessage(sendResponse) {
  try {
    await getAuthToken(true);
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

/**
 * Handles a SIGN_OUT request from the popup by clearing and revoking the cached token
 * @param {function(Object): void} sendResponse - Callback to reply to the popup
 * @returns {Promise<void>}
 */
async function handleSignOutMessage(sendResponse) {
  try {
    const token = await getAuthToken(false);
    await clearCachedToken(token);
    await revokeToken(token);
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

/**
 * Handles a CHECK_NOW request from the popup by forgetting previously notified events,
 * running an immediate calendar check, and reporting today's remaining events so the
 * popup can show what was seen
 * @param {function(Object): void} sendResponse - Callback to reply to the popup
 * @returns {Promise<void>}
 */
async function handleCheckNowMessage(sendResponse) {
  try {
    await saveNotifiedEventIds({});
    await checkUpcomingEvents();
    const token = await getAuthToken(false);
    const events = (await fetchTodaysRemainingEvents(token)).map(summarizeEventForDisplay);
    sendResponse({ ok: true, events });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

/**
 * Handles a GET_STATUS request from the popup by reporting whether a token is cached
 * @param {function(Object): void} sendResponse - Callback to reply to the popup
 * @returns {Promise<void>}
 */
async function handleGetStatusMessage(sendResponse) {
  try {
    await getAuthToken(false);
    sendResponse({ signedIn: true });
  } catch {
    sendResponse({ signedIn: false });
  }
}

/**
 * Routes messages from the popup to their handler
 * @param {Object} message - The message sent from the popup
 * @param {chrome.runtime.MessageSender} _sender - The message sender (unused)
 * @param {function(Object): void} sendResponse - Callback to reply to the popup
 * @returns {boolean} True to indicate the response will be sent asynchronously
 */
function handleMessage(message, _sender, sendResponse) {
  const handlers = {
    SIGN_IN: handleSignInMessage,
    SIGN_OUT: handleSignOutMessage,
    CHECK_NOW: handleCheckNowMessage,
    GET_STATUS: handleGetStatusMessage,
  };

  const handler = handlers[message.type];
  if (!handler) {
    return false;
  }

  handler(sendResponse);
  return true;
}

chrome.runtime.onInstalled.addListener(createCheckAlarm);
chrome.runtime.onStartup.addListener(createCheckAlarm);
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.notifications.onClicked.addListener(handleNotificationClick);
chrome.notifications.onButtonClicked.addListener(handleNotificationClick);
chrome.runtime.onMessage.addListener(handleMessage);
