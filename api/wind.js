// This file replaces /api/wind.js
// We are back to using built-in fetch and no external libraries.

// --- This is the "winning formula" header object ---
const requestHeaders = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
};

export default async function handler(req, res) {
  // 1. Get lat/lon from the Garmin device's query
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing lat/lon parameters" });
  }

  try {
    // --- STEP 1: Get Nearest Station (using fetch) ---
    // Using the correct "publicapi" domain and "latitude"/"longitude" params
    const stationURL = `https://publicapi.envir.ee/v1/combinedWeatherData/nearestStationByCoordinates?latitude=${lat}&longitude=${lon}`;
    
    const stationRes = await fetch(stationURL, { headers: requestHeaders });

    if (!stationRes.ok) {
      throw new Error(`EMHI P1 Error: ${stationRes.status}`);
    }
    
    // --- We are now *expecting* JSON, not XML ---
    const stationData = await stationRes.json(); 
    
    // The response is { "entries": { "entry": [ ... ] } }
    const station = stationData?.entries?.entry?.[0];

    if (!station) {
      return res.status(500).json({ error: "P1_PARSE (JSON)" });
    }

    const distance = station.kaugus; // This is a String, e.g. "5.9"
    const name = station.nimi; 

    // --- STEP 2: Your 200km Check ---
    if (parseFloat(distance) > 200) {
      return res.status(200).json({ error: "OOR" }); // Out of Range
    }

    // --- STEP 3: Get Wind Data (Fallback Logic) ---
    const now = new Date();
    const estonianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Tallinn' }));
    const nameToMatch = name.split(" ")[0]; // "Pirita RJ" -> "Pirita"

    for (let hourOffset = 0; hourOffset <= 3; hourOffset++) {
      const timeToTry = new Date(estonianTime.getTime() - hourOffset * 3600000); 

      const dateStr = timeToTry.toISOString().split('T')[0];
      const hourStr = timeToTry.getHours().toString().padStart(2, '0');

      const windURL = `https://publicapi.envir.ee/v1/wind/observationWind?date=${dateStr}&hour=${hourStr}`;
      
      const windRes = await fetch(windURL, { headers: requestHeaders }); // Re-use the same headers

      if (!windRes.ok) {
        throw new Error(`EMHI P2 Error: ${windRes.status} for hour ${hourStr}`);
      }
      
      // --- Expecting JSON for the second call as well ---
      const windData = await windRes.json();
      
      const allStations = windData?.entries?.entry;

      if (!allStations) {
        continue; 
      }

      // --- STEP 4: Find Matching Station ---
      const stationMatch = allStations.find(s => s.jaam === nameToMatch);
      if (!stationMatch) {
        continue;
      }

      // --- STEP 5: Fix & Format Data ---
      const ws10ma_str = stationMatch.ws10ma; 
      const wd10ma_str = stationMatch.wd10ma; 

      if (ws10ma_str === null || wd10ma_str === null) {
        continue;
      }

      const windSpeed = parseFloat(ws10ma_str.replace(",", "."));
      const windDir = parseFloat(wd10ma_str);

      res.setHeader('Cache-Control', 's-maxage=3600'); 
      return res.status(200).json({
        windSpeed: windSpeed,
        windDir: windDir
      });
    }

    return res.status(200).json({ error: "NO_DATA" });

  } catch (error) {
    // If we are here, it's almost certainly the "Unexpected token '<'" error
    console.error(error.message);
    return res.status(500).json({ error: error.message });
  }
}

