const MTA_API_KEY = "5bc63bbc-c4d2-4beb-95f3-1c70ba6c0f4f";

let mapMarkers = [];
let userMarker = null;
let userLocation = null;
let currentSearch = "";

const map = L.map("map").setView([40.7128, -74.0060], 13);

const darkMap = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 20 }
).addTo(map);

const lightMap = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 20 }
);

let darkMode = true;

const userIcon = L.divIcon({
    className: "user-marker-dot",
    iconSize: [16, 16]
});

const busIcon = L.divIcon({
    className: "bus-marker-badge",
    html: "🚌",
    iconSize: [28, 28]
});

function toggleTheme() {
    const button = document.getElementById("themeBtn");

    if (darkMode) {
        document.body.classList.add("light-mode");
        map.removeLayer(darkMap);
        lightMap.addTo(map);
        button.textContent = "Dark Mode";
        darkMode = false;
    } else {
        document.body.classList.remove("light-mode");
        map.removeLayer(lightMap);
        darkMap.addTo(map);
        button.textContent = "Light Mode";
        darkMode = true;
    }
}

function findLocation() {
    if (!navigator.geolocation) {
        alert("Your browser does not support location.");
        return;
    }

    navigator.geolocation.getCurrentPosition(function(position) {
        userLocation = {
            lat: position.coords.latitude,
            lon: position.coords.longitude
        };

        map.setView(
            [userLocation.lat, userLocation.lon],
            14
        );

        if (userMarker) {
            userMarker.setLatLng([
                userLocation.lat,
                userLocation.lon
            ]);
        } else {
            userMarker = L.marker(
                [userLocation.lat, userLocation.lon],
                { icon: userIcon }
            ).addTo(map);

            userMarker.bindPopup("You are here");
        }

        if (currentSearch) {
            searchBus();
        }
    });
}

function getDistance(lat1, lon1, lat2, lon2) {
    const x = lat1 - lat2;
    const y = lon1 - lon2;

    return Math.sqrt(x * x + y * y);
}

function getArrivalTime(bus) {
    const time = bus.MonitoredCall?.ExpectedArrivalTime;

    if (!time) {
        return "Time unavailable";
    }

    const arrival = new Date(time);
    const now = new Date();

    const minutes = Math.round(
        (arrival - now) / 60000
    );

    if (minutes <= 0) {
        return "Arriving now";
    }

    return minutes + " min";
}

async function searchBus() {
    const input = document
        .getElementById("busSearch")
        .value
        .trim()
        .toUpperCase();

    if (!input) {
        alert("Enter a bus route.");
        return;
    }

    currentSearch = input;

    document.getElementById("route").textContent = input;
    document.getElementById("status").textContent = "Loading...";
    document.getElementById("distance").textContent = "--";
    document.getElementById("arrival").textContent = "--";
    document.getElementById("nextStop").textContent = "--";

    const lineRef = `MTA NYCT_${input}`;

    try {
        const url =
            `https://bustime.mta.info/api/siri/vehicle-monitoring.json?key=${MTA_API_KEY}&LineRef=${lineRef}`;

        const proxy =
            `https://corsproxy.io/?${encodeURIComponent(url)}`;

        const response = await fetch(proxy);
        const data = await response.json();

        const buses =
            data?.Siri?.ServiceDelivery
            ?.VehicleMonitoringDelivery?.[0]
            ?.VehicleActivity || [];

        mapMarkers.forEach(function(marker) {
            map.removeLayer(marker);
        });

        mapMarkers = [];

        if (buses.length === 0) {
            document.getElementById("status").textContent =
                "No active buses found";
            return;
        }

        let closestBus = buses[0];
        let closestDistance = Infinity;

        buses.forEach(function(bus) {
            const location =
                bus.MonitoredVehicleJourney.VehicleLocation;

            if (!location || !userLocation) {
                return;
            }

            const distance = getDistance(
                userLocation.lat,
                userLocation.lon,
                location.Latitude,
                location.Longitude
            );

            if (distance < closestDistance) {
                closestDistance = distance;
                closestBus = bus;
            }
        });

        const journey =
            closestBus.MonitoredVehicleJourney;

        const location =
            journey.VehicleLocation;

        document.getElementById("status").textContent =
            buses.length + " bus(es) active";

        document.getElementById("arrival").textContent =
            getArrivalTime(journey);

        document.getElementById("nextStop").textContent =
            journey.MonitoredCall?.StopPointName ||
            "In transit";

        if (userLocation) {
            document.getElementById("distance").textContent =
                closestDistance.toFixed(2) + " mi away";
        }

        buses.forEach(function(bus) {
            const journey =
                bus.MonitoredVehicleJourney;

            const location =
                journey.VehicleLocation;

            if (!location) {
                return;
            }

            const marker = L.marker(
                [location.Latitude, location.Longitude],
                { icon: busIcon }
            ).addTo(map);

            marker.bindPopup(
                "Bus " + input +
                "<br>Arrival: " +
                getArrivalTime(journey) +
                "<br>Next stop: " +
                (journey.MonitoredCall?.StopPointName ||
                "In transit")
            );

            mapMarkers.push(marker);
        });

        map.setView(
            [location.Latitude, location.Longitude],
            14
        );

    } catch (error) {
        console.log(error);

        document.getElementById("status").textContent =
            "Error loading bus data";
    }
}

function refreshBus() {
    if (currentSearch) {
        searchBus();
    }
}

findLocation();

setInterval(function() {
    if (currentSearch) {
        searchBus();
    }
}, 20000);

if (typeof firebase !== "undefined" && firebase.apps.length) {
    const db = firebase.database().ref("messages");

    document.getElementById("chat-send").onclick =
        function() {

        const input =
            document.getElementById("chat-input");

        if (input.value.trim()) {
            db.push({
                text: input.value.trim()
            });

            input.value = "";
        }
    };

    db.on("child_added", function(snapshot) {
        const message = document.createElement("p");

        message.textContent =
            snapshot.val().text;

        document
            .getElementById("chat-messages")
            .appendChild(message);
    });
}