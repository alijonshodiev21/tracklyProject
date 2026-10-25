import { auth, db } from "./init-firebase.js";

import {
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
  ref,
  push,
  query,
  limitToLast,
  onValue
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

const routeForm = document.getElementById("routeForm");
const routeInput = document.getElementById("routeInput");
const directionSelect = document.getElementById("directionSelect");
const searchButton = document.getElementById("searchButton");
const locationButton = document.getElementById("locationButton");
const themeButton = document.getElementById("themeButton");
const busCount = document.getElementById("busCount");
const busStatus = document.getElementById("busStatus");
const arrivalList = document.getElementById("arrivalList");
const updatedAt = document.getElementById("updatedAt");
const locationHelp = document.getElementById("locationHelp");
const chatStatus = document.getElementById("chatStatus");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatName = document.getElementById("chatName");
const chatInput = document.getElementById("chatInput");
const sendButton = document.getElementById("sendButton");

if (!window.L) {
  throw new Error(
    "Leaflet map did not load. Check your internet connection and refresh."
  );
}

const map = L.map("map").setView([40.6500, -73.9500], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const busLayer = L.layerGroup().addTo(map);
const locationLayer = L.layerGroup().addTo(map);

let currentRoute = "B82";
let currentBuses = [];
let userLocation = null;
let currentUser = null;
let busRefreshTimer = null;
let etaTimer = null;
let busRequestRunning = false;
let chatListenerStarted = false;

const directionCache = new Map();

function setBusStatus(text) {
  busStatus.textContent = text;
}

function setChatStatus(text) {
  chatStatus.textContent = text;
}

function safeText(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]
  );
}

function parseBuses(payload) {
  if (Array.isArray(payload?.buses)) {
    return payload.buses.filter(bus =>
      Number.isFinite(Number(bus.latitude)) &&
      Number.isFinite(Number(bus.longitude))
    );
  }

  const deliveries =
    payload?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery;

  const deliveryList = Array.isArray(deliveries)
    ? deliveries
    : deliveries
      ? [deliveries]
      : [];

  const result = [];

  for (const delivery of deliveryList) {
    const activities = Array.isArray(delivery?.VehicleActivity)
      ? delivery.VehicleActivity
      : delivery?.VehicleActivity
        ? [delivery.VehicleActivity]
        : [];

    for (const activity of activities) {
      const journey = activity?.MonitoredVehicleJourney || {};

      const latitude = Number(journey.VehicleLocation?.Latitude);
      const longitude = Number(journey.VehicleLocation?.Longitude);

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        (!latitude && !longitude)
      ) {
        continue;
      }

      const monitoredCall = journey.MonitoredCall || {};

      const onwardCallsValue = journey.OnwardCalls?.OnwardCall;

      const onwardCalls = Array.isArray(onwardCallsValue)
        ? onwardCallsValue
        : onwardCallsValue
          ? [onwardCallsValue]
          : [];

      const upcomingCall = onwardCalls.find(call =>
        call?.ExpectedArrivalTime ||
        call?.ExpectedDepartureTime
      );

      const lineRef = String(
        journey.LineRef || ""
      ).split("_").pop();

      result.push({
        route: String(
          journey.PublishedLineName ||
          lineRef ||
          currentRoute
        ).toUpperCase(),

        directionRef: String(
          journey.DirectionRef ?? "unknown"
        ),

        destination: String(
          journey.DestinationName ||
          journey.DirectionName ||
          "Destination unavailable"
        ),

        vehicleId: String(
          journey.VehicleRef || "Unknown"
        ),

        latitude,
        longitude,

        nextStop: String(
          upcomingCall?.StopPointName ||
          upcomingCall?.StopPointRef ||
          monitoredCall.StopPointName ||
          "Stop unavailable"
        ),

        expectedArrivalTime:
          monitoredCall.ExpectedArrivalTime ||
          monitoredCall.ExpectedDepartureTime ||
          upcomingCall?.ExpectedArrivalTime ||
          upcomingCall?.ExpectedDepartureTime ||
          null,

        recordedAtTime: activity?.RecordedAtTime || null
      });
    }
  }

  return result;
}

function updateDirections() {
  const previous = directionSelect.value;

  const cached = directionCache.get(currentRoute) || new Map();

  for (const bus of currentBuses) {
    if (
      bus.directionRef &&
      bus.directionRef !== "unknown" &&
      bus.destination &&
      bus.destination !== "Destination unavailable"
    ) {
      cached.set(bus.directionRef, bus.destination);
    }
  }

  directionCache.set(currentRoute, cached);

  directionSelect.replaceChildren();

  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All destinations";

  directionSelect.appendChild(all);

  for (
    const [direction, destination]
    of [...cached.entries()].sort(
      ([a], [b]) => a.localeCompare(b, undefined, { numeric: true })
    )
  ) {
    const option = document.createElement("option");

    option.value = direction;
    option.textContent = `Toward ${destination}`;

    directionSelect.appendChild(option);
  }

  directionSelect.disabled = cached.size === 0;

  directionSelect.value =
    previous === "all" || cached.has(previous)
      ? previous
      : "all";
}

function etaFor(bus) {
  if (!bus.expectedArrivalTime) {
    return {
      main: "ETA unavailable",
      clock: "No arrival estimate from MTA"
    };
  }

  const time = new Date(bus.expectedArrivalTime);

  if (Number.isNaN(time.getTime())) {
    return {
      main: "ETA unavailable",
      clock: "Invalid arrival estimate"
    };
  }

  const minutes = Math.ceil(
    (time.getTime() - Date.now()) / 60000
  );

  const clock = time.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });

  if (minutes <= 0) {
    return {
      main: minutes >= -1 ? "Due now" : "Refreshing ETA...",
      clock: `Reported time: ${clock}`
    };
  }

  return {
    main: `${minutes} min`,
    clock: `Estimated time: ${clock}`
  };
}

function closestBuses() {
  const selected = directionSelect.value;

  const candidates = selected === "all"
    ? currentBuses
    : currentBuses.filter(
        bus => bus.directionRef === selected
      );

  if (!candidates.length) {
    return [];
  }

  const center = userLocation || map.getCenter();

  return [...candidates]
    .sort((a, b) => {
      const distanceA = map.distance(
        center,
        L.latLng(a.latitude, a.longitude)
      );

      const distanceB = map.distance(
        center,
        L.latLng(b.latitude, b.longitude)
      );

      return distanceA - distanceB;
    })
    .slice(0, 1);
}

function renderBuses(zoomToBus = false) {
  busLayer.clearLayers();

  const visible = closestBuses();

  if (!visible.length) {
    busCount.textContent = "0 nearest buses";

    arrivalList.innerHTML = `
      <div class="empty-state">
        No buses are reporting for this route and direction.
        Try another direction or check again shortly.
      </div>
    `;

    setBusStatus(
      currentBuses.length
        ? "No buses are reporting in this direction right now."
        : `No buses are currently reporting for ${currentRoute}.`
    );

    return;
  }

  const bus = visible[0];
  const eta = etaFor(bus);

  const icon = L.divIcon({
    className: "",
    html: '<div class="bus-marker">🚌</div>',
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });

  const popup = `
    <div class="direction-popup">
      <strong>Nearest ${safeText(bus.route)} bus</strong>
      <div>To: ${safeText(bus.destination)}</div>
      <div>Next stop: ${safeText(bus.nextStop)}</div>
      <div><strong>${safeText(eta.main)}</strong></div>
      <div class="popup-muted">${safeText(eta.clock)}</div>
    </div>
  `;

  L.marker(
    [bus.latitude, bus.longitude],
    { icon }
  )
    .bindPopup(popup)
    .addTo(busLayer);

  busCount.textContent = "1 nearest bus";

  setBusStatus(
    userLocation
      ? "Showing the bus closest to your location."
      : "Showing the bus closest to the map center. Tap My Location for a more accurate result."
  );

  renderBusCard(bus);

  if (zoomToBus) {
    map.setView(
      [bus.latitude, bus.longitude],
      15
    );
  }
}

function renderBusCard(bus) {
  arrivalList.replaceChildren();

  const eta = etaFor(bus);

  const card = document.createElement("article");
  card.className = "arrival-card";

  const details = document.createElement("div");

  const route = document.createElement("div");
  route.className = "bus-route";
  route.textContent = `${bus.route} · Nearest`;

  const destination = document.createElement("div");
  destination.className = "bus-destination";
  destination.textContent = `To ${bus.destination}`;

  const stop = document.createElement("div");
  stop.className = "bus-details";
  stop.textContent = `Next stop: ${bus.nextStop}`;

  const vehicle = document.createElement("div");
  vehicle.className = "bus-details";
  vehicle.textContent = `Vehicle: ${bus.vehicleId}`;

  details.append(route, destination, stop, vehicle);

  const etaBox = document.createElement("div");
  etaBox.className = "eta-box";

  const main = document.createElement("div");
  main.className = "eta-main";
  main.textContent = eta.main;

  const clock = document.createElement("div");
  clock.className = "eta-clock";
  clock.textContent = eta.clock;

  etaBox.append(main, clock);
  card.append(details, etaBox);

  arrivalList.appendChild(card);
}

async function fetchBusData(zoomToBus = false) {
  if (busRequestRunning) return;

  busRequestRunning = true;

  searchButton.disabled = true;
  searchButton.textContent = "Searching...";

  setBusStatus(`Loading ${currentRoute} bus data...`);

  try {
    const response = await fetch(
      `/api/buses?route=${encodeURIComponent(currentRoute)}`,
      { cache: "no-store" }
    );

    const payload = await response.json();

    if (!response.ok || payload.error) {
      throw new Error(
        payload.error || `Server error ${response.status}`
      );
    }

    const previousDirection = directionSelect.value;

    currentBuses = parseBuses(payload).filter(
      bus => String(bus.route).toUpperCase() === currentRoute
    );

    updateDirections();

    // Keep the selection if that direction still exists.
    if (
      previousDirection !== "all" &&
      [...directionSelect.options].some(
        option => option.value === previousDirection
      )
    ) {
      directionSelect.value = previousDirection;
    }

    renderBuses(zoomToBus);

    updatedAt.textContent =
      `MTA feed checked ${new Date().toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      })}`;
  } catch (error) {
    console.error("Bus data error:", error);

    setBusStatus(`Bus data error: ${error.message}`);

    busCount.textContent = "Unavailable";

    arrivalList.innerHTML = `
      <div class="empty-state">
        ${safeText(error.message)}.
        Check that the server is running and your MTA API key is set in .env.
      </div>
    `;
  } finally {
    busRequestRunning = false;
    searchButton.disabled = false;
    searchButton.textContent = "Find Bus";
  }
}

routeForm.addEventListener("submit", async event => {
  event.preventDefault();

  const newRoute = routeInput.value.trim().toUpperCase();

  if (!/^[A-Z0-9-]{1,8}$/.test(newRoute)) {
    setBusStatus("Enter a valid bus route, such as B82 or Q58.");
    return;
  }

  // Only reset direction when changing to a different route.
  if (newRoute !== currentRoute) {
    currentRoute = newRoute;
    directionSelect.value = "all";
  }

  await fetchBusData(true);
});

directionSelect.addEventListener("change", () => {
  renderBuses(true);
});

locationButton.addEventListener("click", () => {
  locationHelp.hidden = true;

  if (!navigator.geolocation) {
    locationHelp.textContent =
      "This browser does not support location services.";

    locationHelp.hidden = false;
    return;
  }

  locationButton.disabled = true;
  locationButton.textContent = "Finding location...";

  navigator.geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude, accuracy } = position.coords;

      userLocation = L.latLng(latitude, longitude);

      locationLayer.clearLayers();

      L.circle([latitude, longitude], {
        radius: Math.min(
          Math.max(accuracy || 30, 10),
          500
        ),
        color: "#2474ff",
        weight: 1,
        fillColor: "#2474ff",
        fillOpacity: 0.08
      }).addTo(locationLayer);

      L.marker([latitude, longitude], {
        icon: L.divIcon({
          className: "",
          html: '<div class="location-marker"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9]
        })
      })
        .bindPopup("Your approximate location")
        .addTo(locationLayer);

      map.setView([latitude, longitude], 14);

      renderBuses(false);

      locationHelp.textContent =
        "Your location is shown. The closest bus is chosen by straight-line distance.";

      locationHelp.hidden = false;

      locationButton.disabled = false;
      locationButton.textContent = "◎ My Location";
    },

    error => {
      const messages = {
        1: "Location permission denied. Allow location in browser settings and try again.",
        2: "Your location is unavailable. Check device location settings.",
        3: "Location timed out. Try again."
      };

      locationHelp.textContent =
        messages[error.code] || "Unable to find your location.";

      locationHelp.hidden = false;

      locationButton.disabled = false;
      locationButton.textContent = "◎ My Location";
    },

    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 30000
    }
  );
});

function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);

  themeButton.textContent = dark
    ? "☀ Light Mode"
    : "☾ Dark Mode";

  try {
    localStorage.setItem(
      "trackly-theme",
      dark ? "dark" : "light"
    );
  } catch {
    // The theme still works if local storage is unavailable.
  }

  setTimeout(() => map.invalidateSize(), 100);
}

themeButton.addEventListener("click", () => {
  applyTheme(
    !document.body.classList.contains("dark")
  );
});

try {
  applyTheme(
    localStorage.getItem("trackly-theme") === "dark"
  );
} catch {
  applyTheme(false);
}

function renderChatMessages(items) {
  chatMessages.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No messages yet. Start the conversation.";

    chatMessages.appendChild(empty);
    return;
  }

  for (const data of items) {
    if (
      !data ||
      typeof data.text !== "string" ||
      !data.text.trim()
    ) {
      continue;
    }

    const message = document.createElement("article");
    message.className = "chat-message";

    if (currentUser && data.uid === currentUser.uid) {
      message.classList.add("mine");
    }

    const name = document.createElement("span");
    name.className = "chat-message-name";
    name.textContent = String(data.name || "Rider").slice(0, 24);

    const text = document.createElement("div");
    text.className = "chat-message-text";
    text.textContent = data.text.slice(0, 300);

    const time = document.createElement("div");
    time.className = "chat-message-time";

    if (typeof data.createdAt === "number") {
      time.textContent = new Date(
        data.createdAt
      ).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      });
    }

    message.append(name, text, time);
    chatMessages.appendChild(message);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function startChatListener() {
  if (chatListenerStarted) return;

  chatListenerStarted = true;

  const recentMessages = query(
    ref(db, "messages"),
    limitToLast(50)
  );

  onValue(
    recentMessages,

    snapshot => {
      const messages = [];

      snapshot.forEach(child => {
        messages.push(child.val());
      });

      renderChatMessages(messages);
      setChatStatus("Chat connected");
    },

    error => {
      console.error("Firebase chat read error:", error);

      setChatStatus(
        `Chat could not load: ${error.message}`
      );

      chatListenerStarted = false;
    }
  );
}

signInAnonymously(auth)
  .then(credential => {
    currentUser = credential.user;

    setChatStatus("Chat connected");

    startChatListener();
  })
  .catch(error => {
    console.error("Firebase sign-in error:", error);

    setChatStatus(
      `Chat sign-in failed: ${error.message}. Check Anonymous sign-in in Firebase Console.`
    );
  });

chatForm.addEventListener("submit", async event => {
  event.preventDefault();

  const text = chatInput.value.trim().slice(0, 300);
  const name = chatName.value.trim().slice(0, 24) || "Rider";

  if (!text) return;

  if (!currentUser) {
    setChatStatus(
      "Chat is still connecting. Try again in a moment."
    );
    return;
  }

  sendButton.disabled = true;

  try {
    await push(ref(db, "messages"), {
      name,
      text,
      uid: currentUser.uid,
      createdAt: Date.now()
    });

    chatInput.value = "";
    chatInput.focus();

    setChatStatus("Chat connected");
  } catch (error) {
    console.error("Firebase chat write error:", error);

    setChatStatus(
      `Message could not be sent: ${error.message}. Check Realtime Database rules.`
    );
  } finally {
    sendButton.disabled = false;
  }
});

fetchBusData(true);

busRefreshTimer = setInterval(() => {
  fetchBusData(false);
}, 30000);

etaTimer = setInterval(() => {
  if (currentBuses.length) {
    renderBuses(false);
  }
}, 15000);