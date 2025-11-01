// This file replaces /api/wind.js
import axios from 'axios';

export default async function handler(req, res) {
  // 1. Get lat/lon from the Garmin device's query
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing lat/lon parameters" });
  }

  // --- THIS IS THE FIX ---
  // We are adding more headers to look identical to a browser/curl
  // and to force any upstream caches (like Vercel's) to get a fresh copy.
  const requestHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Accept-Encoding': 'gzip, deflate, br'
  };
  // --- END OF FIX ---

  try {
    // --- STEP 1: Get Nearest Station (using axios) ---
    const stationURL = `https://publicapi.envir.ee/v1/combinedWeatherData/nearestStationByCoordinates`;

    const stationRes = await axios.get(stationURL, {
      headers: requestHeaders,
      params: {
        latitude: lat,
        longitude: lon
      }
    });

    const stationData = stationRes.data;
    const station = stationData?.entries?.entry?.[0];

    if (!station) {
      return res.status(500).json({ error: "P1_PARSE" });
    }

    const distance = station.kaugus;
    const name = station.nimi;

    // --- STEP 2: Your 200km Check ---
    if (parseFloat(distance) > 200) {
      return res.status(200).json({ error: "OOR" }); // Out of Range
    }

    // --- STEP 3: Get Wind Data (Fallback Logic) ---
    const now = new Date();
    const estonianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Tallinn' }));
    const nameToMatch = name.split(" ")[0];

    for (let hourOffset = 0; hourOffset <= 3; hourOffset++) {
      const timeToTry = new Date(estonianTime.getTime() - hourOffset * 3600000);

      const dateStr = timeToTry.toISOString().split('T')[0];
      const hourStr = timeToTry.getHours().toString().padStart(2, '0');

      const windURL = `https://publicapi.envir.ee/v1/wind/observationWind`;

      const windRes = await axios.get(windURL, {
        headers: requestHeaders, // Re-use the same headers
        params: {
          date: dateStr,
          hour: hourStr
        }
      });

      const windData = windRes.data;
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
    if (error.response) {
      console.error("Axios Error:", error.response.data);
      return res.status(500).json({ error: `Axios Error: ${error.response.status}`, data: error.response.data });
    }
    console.error("Generic Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}

