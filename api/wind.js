// This file replaces /api/wind.js
// We now import the 'fast-xml-parser' library
import { XMLParser } from 'fast-xml-parser';

// --- This is the new header. We are now *asking* for XML ---
const requestHeaders = {
  'Accept': 'application/xml',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Accept-Encoding': 'gzip, deflate, br'
};

// --- This is the new XML parser configuration ---
const xmlParserOptions = {
  ignoreAttributes: false, // We don't need attributes
  parseAttributeValue: false,
  allowBooleanAttributes: false,
  trimValues: true,
  cdataPropName: false,
  commentPropName: false,
  numberParseOptions: {
    hex: false,
    leadingZeros: false,
  },
  isArray: (name, jpath, isLeafNode, isAttribute) => {
    // Tell the parser that "entry" is *always* an array
    // This fixes a bug where if only 1 station reports, it's an object instead of an array
    if (jpath === "entries.entry") return true;
  }
};
const parser = new XMLParser(xmlParserOptions);

export default async function handler(req, res) {
  // 1. Get lat/lon from the Garmin device's query
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing lat/lon parameters" });
  }

  try {
    // --- STEP 1: Get Nearest Station (Requesting XML) ---
    const stationURL = `https://publicapi.envir.ee/v1/combinedWeatherData/nearestStationByCoordinates?latitude=${lat}&longitude=${lon}`;

    // We use the built-in fetch, which is fine
    const stationRes = await fetch(stationURL, { headers: requestHeaders });

    if (!stationRes.ok) {
      throw new Error(`EMHI P1 Error: ${stationRes.status}`);
    }

    // --- THIS IS THE NEW LOGIC ---
    // 1. Get the response as raw text
    const stationXML = await stationRes.text();
    // 2. Parse the XML text into a JavaScript object
    const stationData = parser.parse(stationXML);
    // --- END OF NEW LOGIC ---

    // The response is { entries: { entry: [ ... ] } }
    const station = stationData?.entries?.entry?.[0];

    if (!station) {
      return res.status(500).json({ error: "P1_PARSE (XML)", data: stationData });
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

      const windURL = `https://publicapi.envir.ee/v1/wind/observationWind?date=${dateStr}&hour=${hourStr}`;

      // --- Requesting XML for the second call ---
      const windRes = await fetch(windURL, { headers: requestHeaders });

      if (!windRes.ok) {
        throw new Error(`EMHI P2 Error: ${windRes.status} for hour ${hourStr}`);
      }

      // --- Parse the second XML response ---
      const windXML = await windRes.text();
      const windData = parser.parse(windXML);

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
    console.error("Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}
