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

  console.log(`--- NEW REQUEST: lat=${lat}, lon=${lon} ---`);

  try {
    // --- STEP 1: Get Nearest Station (using fetch) ---
    const stationURL = `https://publicapi.envir.ee/v1/combinedWeatherData/nearestStationByCoordinates?latitude=${lat}&longitude=${lon}`;

    const stationRes = await fetch(stationURL, { headers: requestHeaders });

    if (!stationRes.ok) {
      throw new Error(`EMHI P1 Error: ${stationRes.status}`);
    }

    const stationData = await stationRes.json();
    const station = stationData?.entries?.entry?.[0];

    if (!station) {
      return res.status(500).json({ error: "P1_PARSE (JSON)" });
    }

    const distance = station.kaugus;
    const name = station.nimi; // e.g. "Otepää SMJ"
    console.log(`STEP 1 SUCCESS: Found name='${name}', distance='${distance}'`);

    // --- STEP 2: Your 200km Check ---
    if (parseFloat(distance) > 200) {
      console.log("STEP 2 FAILED: Out of Range (>200km)");
      return res.status(200).json({ error: "OOR" }); // Out of Range
    }

    // --- STEP 3: Get Wind Data (Fallback Logic) ---
    const now = new Date();
    const estonianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Tallinn' }));

    // --- THIS IS THE FIX ---
    // We will use the full, unmodified name from Step 1
    const nameToMatch = name;
    console.log(`Attempting to match exact station name: '${nameToMatch}'`);
    // --- END OF FIX ---

    for (let hourOffset = 0; hourOffset <= 3; hourOffset++) {
      const timeToTry = new Date(estonianTime.getTime() - hourOffset * 3600000);

      const dateStr = timeToTry.toISOString().split('T')[0];
      const hourStr = timeToTry.getHours().toString().padStart(2, '0');

      console.log(`--- Checking hour ${hourStr} (offset ${hourOffset}) ---`);

      const windURL = `https://publicapi.envir.ee/v1/wind/observationWind?date=${dateStr}&hour=${hourStr}`;
      const windRes = await fetch(windURL, { headers: requestHeaders });

      if (!windRes.ok) {
        throw new Error(`EMHI P2 Error: ${windRes.status} for hour ${hourStr}`);
      }

      const windData = await windRes.json();
      const allStations = windData?.entries?.entry;

      if (!allStations) {
        console.log(`Hour ${hourStr} data is empty. Trying previous hour.`);
        continue;
      }

      // --- STEP 4: Find Matching Station ---
      // We use the exact 'nameToMatch' and the correct 'Jaam' key
      const stationMatch = allStations.find(s => s.Jaam === nameToMatch);

      if (!stationMatch) {
        console.log(`No match for '${nameToMatch}'. Available stations in this hour:`);
        console.log(allStations.slice(0, 5).map(s => s.Jaam)); // Log first 5 station names
        continue;
      }

      // --- STEP 5: Fix & Format Data ---
      const ws10ma_str = stationMatch.ws10ma;
      const wd10ma_str = stationMatch.wd10ma;

      if (ws10ma_str === null || wd10ma_str === null) {
        console.log(`Match found ('${nameToMatch}'), but data is null. Trying previous hour.`);
        continue;
      }

      // --- WE FOUND VALID DATA! ---
      console.log(`!!! SUCCESS: Found valid data for '${nameToMatch}' at hour ${hourStr}`);
      const windSpeed = parseFloat(ws10ma_str.replace(",", "."));
      const windDir = parseFloat(wd10ma_str);

      res.setHeader('Cache-Control', 's-maxage=3600');
      return res.status(200).json({
        windSpeed: windSpeed,
        windDir: windDir
      });
    }

    console.log("--- Loop finished. No data found in 4 attempts. ---");
    return res.status(200).json({ error: "NO_DATA" });

  } catch (error) {
    console.error("--- CATCH BLOCK ERROR ---");
    console.error(error.message);
    return res.status(500).json({ error: error.message });
  }
}

