// This is a Vercel Serverless Function (Node.js)
// This file replaces /api/wind.js

export default async function handler(req, res) {
  // 1. Get lat/lon from the Garmin device's query
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing lat/lon parameters" });
  }

  // --- THIS IS THE FIX ---
  // We must send this header so EMHI returns JSON instead of XML
  const requestHeaders = {
    'accept': 'application/json'
  };
  // --- END OF FIX ---

  try {
    // --- STEP 1: Get Nearest Station (Your Logic) ---
    const stationURL = `https://publicapi.envir.ee/v1/combinedWeatherData/nearestStationByCoordinates?lat=${lat}&lon=${lon}`;
    
    // --- THIS IS THE FIX ---
    // Added the headers to the fetch call
    const stationRes = await fetch(stationURL, { headers: requestHeaders });
    // --- END OF FIX ---

    if (!stationRes.ok) {
      throw new Error(`EMHI P1 Error: ${stationRes.status}`);
    }
    
    const stationData = await stationRes.json();
    
    // Drill into the JSON
    const station = stationData?.entries?.entry?.[0];
    if (!station) {
      return res.status(500).json({ error: "P1_PARSE" });
    }

    const distance = station.kaugus;
    const name = station.nimi; // e.g., "Pirita RJ"

    // --- STEP 2: Your 200km Check ---
    if (distance > 200) {
      return res.status(200).json({ error: "OOR" }); // Out of Range
    }

    // --- STEP 3: Get Wind Data (Your Logic) ---
    const now = new Date();
    // Get time in 'Europe/Tallinn' time zone
    const estonianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Tallinn' }));
    
    // Format date and hour based on Estonian time
    const dateStr = estonianTime.toISOString().split('T')[0]; // "YYYY-MM-DD"
    
    // --- THIS IS A TIMEZONE FIX ---
    // We use getHours() to get the local Estonian hour (e.g., 12)
    // not getUTCHours() (which would be 10)
    const hourStr = estonianTime.getHours().toString().padStart(2, '0'); // "HH"
    // --- END OF FIX ---

    const windURL = `https://publicapi.envir.ee/v1/wind/observationWind?date=${dateStr}&hour=${hourStr}`;

    // --- THIS IS THE FIX ---
    // Added the headers to the *second* fetch call
    const windRes = await fetch(windURL, { headers: requestHeaders });
    // --- END OF FIX ---

    if (!windRes.ok) {
      throw new Error(`EMHI P2 Error: ${windRes.status}`);
    }
    
    const windData = await windRes.json();
    const allStations = windData?.entries?.entry;
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
    // This is what you saw. The try/catch block worked!
    return res.status(500).json({ error: error.message });
  }
}

