// This is a Vercel Serverless Function (Node.js)
// This file replaces /api/wind.js

export default async function handler(req, res) {
  // 1. Get lat/lon from the Garmin device's query
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing lat/lon parameters" });
  }

  // --- THE "WINNING FORMULA" HEADERS ---
  const requestHeaders = new Headers();
  requestHeaders.append('Accept', 'application/json');
  requestHeaders.append('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36');
  // --- END ---

  try {
    // --- STEP 1: Get Nearest Station (Your Logic) ---
    
    // --- THE "WINNING FORMULA" URL ---
    // Domain: publicapi.envir.ee
    // Params: latitude= & longitude=
    const stationURL = `https://publicapi.envir.ee/v1/combinedWeatherData/nearestStationByCoordinates?latitude=${lat}&longitude=${lon}`;
    // --- END ---
    
    const stationRes = await fetch(stationURL, { headers: requestHeaders });

    if (!stationRes.ok) {
      throw new Error(`EMHI P1 Error: ${stationRes.status}`);
    }
    
    const stationData = await stationRes.json(); 
    
    // The response is { "entries": { "entry": [ ... ] } }
    const station = stationData?.entries?.entry?.[0];

    if (!station) {
      return res.status(500).json({ error: "P1_PARSE" });
    }

    const distance = station.kaugus; // This is a String, e.g. "5.9"
    const name = station.nimi; 

    // --- STEP 2: Your 200km Check ---
    // We must parseFloat() the distance string
    if (parseFloat(distance) > 200) {
      return res.status(200).json({ error: "OOR" }); // Out of Range
    }

    // --- STEP 3: Get Wind Data (Fallback Logic) ---
    const now = new Date();
    const estonianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Tallinn' }));
    const nameToMatch = name.split(" ")[0]; // "Pirita RJ" -> "Pirita"

    // --- THIS IS THE NEW LOGIC ---
    // We will try the current hour, then -1h, -2h, -3h.
    for (let hourOffset = 0; hourOffset <= 3; hourOffset++) {
      const timeToTry = new Date(estonianTime.getTime() - hourOffset * 3600000); // 3600000ms = 1 hour

      const dateStr = timeToTry.toISOString().split('T')[0];
      const hourStr = timeToTry.getHours().toString().padStart(2, '0');

      // Use the same working domain
      const windURL = `https://publicapi.envir.ee/v1/wind/observationWind?date=${dateStr}&hour=${hourStr}`;

      const windRes = await fetch(windURL, { headers: requestHeaders });

      if (!windRes.ok) {
        throw new Error(`EMHI P2 Error: ${windRes.status} for hour ${hourStr}`);
      }
      
      const windData = await windRes.json();
      
      // This API also responds with { "entries": { "entry": [ ... ] } }
      const allStations = windData?.entries?.entry;

      if (!allStations) {
        // This hour's data is likely not published yet, but not a fatal error
        // Continue to the next loop iteration (try the previous hour)
        continue; 
      }

      // --- STEP 4: Find Matching Station ---
      const stationMatch = allStations.find(s => s.jaam === nameToMatch);

      if (!stationMatch) {
        // No match for this station in this hour's data, try previous hour
        continue;
      }

      // --- STEP 5: Fix & Format Data ---
      const ws10ma_str = stationMatch.ws10ma; // "3,6" or null
      const wd10ma_str = stationMatch.wd10ma; // "69.0" or null

      // --- CRITICAL CHECK ---
      // If the data is null (e.g., current hour), try the previous hour
      if (ws10ma_str === null || wd10ma_str === null) {
        continue;
      }

      // --- WE FOUND VALID DATA! ---
      // Fix the comma-decimal
      const windSpeed = parseFloat(ws10ma_str.replace(",", "."));
      const windDir = parseFloat(wd10ma_str);

      // --- FINAL STEP: Send Perfect JSON to Garmin ---
      res.setHeader('Cache-Control', 's-maxage=600'); // Cache for 10 minutes
      return res.status(200).json({
        windSpeed: windSpeed,
        windDir: windDir
      });
    }
    // --- END OF NEW LOGIC ---

    // If the loop finishes without returning, we found no data in 4 attempts.
    return res.status(200).json({ error: "NO_DATA" });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

