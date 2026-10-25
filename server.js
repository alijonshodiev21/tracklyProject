require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const MTA_API_KEY = (process.env.MTA_API_KEY || "").trim();

app.use(express.static(path.join(__dirname, "public")));

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstValue(...values) {
  return values.find(
    value => value !== undefined && value !== null && value !== ""
  );
}

function normalizeBus(activity, requestedRoute) {
  const journey = activity?.MonitoredVehicleJourney || {};
  const location = journey.VehicleLocation || {};

  const lat = Number(location.Latitude);
  const lon = Number(location.Longitude);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    (lat === 0 && lon === 0)
  ) {
    return null;
  }

  const lineRef = String(journey.LineRef || "");
  const publishedLine = String(journey.PublishedLineName || "");
  const lineFromRef = lineRef.split("_").pop();

  const route = (
    publishedLine ||
    lineFromRef ||
    requestedRoute
  ).toUpperCase().trim();

  const monitoredCall = journey.MonitoredCall || {};
  const onwardCalls = asArray(
    journey.OnwardCalls?.OnwardCall
  );

  const nextOnwardCall = onwardCalls.find(call =>
    firstValue(
      call?.ExpectedArrivalTime,
      call?.ExpectedDepartureTime
    )
  );

  const nextCall = nextOnwardCall || monitoredCall;

  const arrival = firstValue(
    monitoredCall.ExpectedArrivalTime,
    monitoredCall.ExpectedDepartureTime,
    nextOnwardCall?.ExpectedArrivalTime,
    nextOnwardCall?.ExpectedDepartureTime,
    null
  );

  return {
    route,
    directionRef: String(
      firstValue(journey.DirectionRef, "unknown")
    ),
    destination: String(
      firstValue(
        journey.DestinationName,
        journey.DirectionName,
        "Destination unavailable"
      )
    ),
    vehicleId: String(
      firstValue(
        journey.VehicleRef,
        journey.FramedVehicleJourneyRef?.DatedVehicleJourneyRef,
        "Unknown"
      )
    ),
    latitude: lat,
    longitude: lon,
    nextStop: String(
      firstValue(
        nextCall?.StopPointName,
        nextCall?.StopPointRef,
        monitoredCall.StopPointName,
        "Stop unavailable"
      )
    ),
    expectedArrivalTime: arrival,
    recordedAtTime: activity?.RecordedAtTime || null
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Trackly"
  });
});

app.get("/api/buses", async (req, res) => {
  const route = String(
    req.query.route || "B82"
  ).trim().toUpperCase();

  if (!/^[A-Z0-9-]{1,8}$/.test(route)) {
    return res.status(400).json({
      error: "Enter a valid bus route, such as B82."
    });
  }

  if (!MTA_API_KEY) {
    return res.status(500).json({
      error: "MTA_API_KEY is missing from your .env file."
    });
  }

  const url = new URL(
    "https://bustime.mta.info/api/siri/vehicle-monitoring.json"
  );

  url.searchParams.set("key", MTA_API_KEY);
  url.searchParams.set("version", "2");
  url.searchParams.set("OperatorRef", "MTA");
  url.searchParams.set("LineRef", `MTA NYCT_${route}`);
  url.searchParams.set("VehicleMonitoringDetailLevel", "calls");
  url.searchParams.set("MaximumNumberOfCallsOnwards", "1");

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000)
    });

    const body = await response.text();

    let data;

    try {
      data = JSON.parse(body);
    } catch {
      console.error(
        "MTA response was not JSON:",
        body.slice(0, 300)
      );

      return res.status(502).json({
        error: "The MTA returned an unexpected response."
      });
    }

    if (!response.ok) {
      console.error(
        "MTA API returned HTTP",
        response.status
      );

      return res.status(502).json({
        error: `MTA API returned HTTP ${response.status}. Check your API key.`
      });
    }

    if (data?.ErrorCondition) {
      console.error("MTA API error:", data.ErrorCondition);

      return res.status(502).json({
        error: "The MTA rejected the request. Check the route and API key."
      });
    }

    const deliveryValue =
      data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery;

    const deliveries = asArray(deliveryValue);

    const buses = deliveries
      .flatMap(delivery =>
        asArray(delivery?.VehicleActivity)
      )
      .map(activity => normalizeBus(activity, route))
      .filter(Boolean)
      .filter(bus => bus.route.toUpperCase() === route);

    res.set("Cache-Control", "no-store");

    return res.json({
      route,
      fetchedAt: new Date().toISOString(),
      buses
    });
  } catch (error) {
    console.error(
      "MTA request failed:",
      error.message
    );

    return res.status(502).json({
      error: "Could not connect to the MTA API. Try again shortly."
    });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "API endpoint not found."
    });
  }

  res.sendFile(
    path.join(__dirname, "public", "index.html"),
    error => {
      if (error) next(error);
    }
  );
});

app.listen(PORT, () => {
  console.log(
    `Trackly is running at http://localhost:${PORT}`
  );

  if (!MTA_API_KEY) {
    console.warn("Add MTA_API_KEY to .env to load bus data.");
  }
});