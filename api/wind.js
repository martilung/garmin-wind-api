// This is a Vercel Serverless Function (Node.js)
// This file replaces /api/wind.js

export default async function handler(req, res) {
  // 1. Get lat/lon from the Garmin device's query
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing lat/lon parameters" });
  }

  // Set the correct headers
  const requestHeaders = new Headers();
  requestHeaders.append('Accept', 'application/json');

  try {
    // --- STEP 1: Get Nearest Station (Your Logic) ---

    // --- THIS IS THE DOMAIN FIX ---
    const stationURL = `https://ilmmicroservice.envir.ee/v1/combinedWeatherData/nearestStationByCoordinates?lat=${lat}&lon=${lon}`;

    // Pass the headers
    const stationRes = await fetch(stationURL, { headers: requestHeaders });

    if (!stationRes.ok) {
      throw new Error(`EMHI P1 Error: ${stationRes.status}`);
    }

    // This line was crashing. It will now receive a JSON Array: [ ... ]
    const stationData = await stationRes.json();

    // --- THIS IS THE PARSER FIX ---
    // The root is an Array, so we take the first element
    const station = stationData?.[0];
    // --- END OF FIX ---

    if (!station) {
      return res.status(500).json({ error: "P1_PARSE" });
    }

    const distance = station.kaugus;
    const name = station.nimi;

    // --- STEP 2: Your 200km Check ---
    if (distance > 200) {
      return res.status(200).json({ error: "OOR" }); // Out of Range
    }

    // --- STEP 3: Get Wind Data (Your Logic) ---
    const now = new Date();
    const estonianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Tallinn' }));
    const dateStr = estonianTime.toISOString().split('T')[0];
    const hourStr = estonianTime.getHours().toString().padStart(2, '0');

    // --- THIS IS THE DOMAIN FIX ---
    const windURL = `https://ilmmicroservice.envir.ee/v1/wind/observationWind?date=${dateStr}&hour=${hourStr}`;

    // Pass the headers to the second call
    const windRes = await fetch(windURL, { headers: requestHeaders });

    if (!windRes.ok) {
      throw new Error(`EMHI P2 Error: ${windRes.status}`);
    }

    // This will also receive a JSON Array: [ ... ]
    const windData = await windRes.json();

    // --- THIS IS THE PARSER FIX ---
    // The root is the Array of all stations
    const allStations = windData;
    // --- END OF FIX ---

    if (!allStations) {
      return res.status(500).json({ error: "P2_PARSE" });
    }

    // --- STEP 4: Find Matching Station ---
    const nameToMatch = name.split(" ")[0]; // "Pirita RJ" -> "Pirita"
    const stationMatch = allStations.find(s => s.jaam === nameToMatch);

    if (!stationMatch) {
      return res.status(200).json({ error: "NO_MATCH" });
    }

    // --- STEP 5: Fix & Format Data ---
    const ws10ma_str = stationMatch.ws10ma; // "3,6"
    const wd10ma_str = stationMatch.wd10ma; // "69.0"

    // Fix the comma-decimal
    const windSpeed = parseFloat(ws10ma_str.replace(",", "."));
    const windDir = parseFloat(wd10ma_str);

    // --- FINAL STEP: Send Perfect JSON to Garmin ---
    res.setHeader('Cache-Control', 's-maxage=600'); // Cache for 10 minutes
    return res.status(200).json({
      windSpeed: windSpeed,
      windDir: windDir
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

