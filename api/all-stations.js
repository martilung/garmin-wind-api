// --- /api/all-stations.js ---
// Provides all station data for the web map portal

const requestHeaders = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
};

// --- Helper to convert DMS (from EMHI strings) to Decimal ---
function dmsToDecimal(kraad, minut, sekund) {
  const K = parseFloat(kraad);
  const M = parseFloat(minut); // Corrected from 'minutes'
  const S = parseFloat(sekund);
  return K + (M / 60) + (S / 3600);
}

// --- Helper to format UTC time string to Estonian HH:mm ---
// We create this formatter once for efficiency
const estonianTimeFormatter = new Intl.DateTimeFormat('et-EE', {
  timeZone: 'Europe/Tallinn',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

// --- Main API Handler for the Web Portal ---
export default async function handler(req, res) {

  // --- 1. CORS FIX ---
  // This header must match your frontend's domain *exactly*.
  res.setHeader('Access-Control-Allow-Origin', 'https://ee-tuul.vercel.app');

  // Handle the browser's pre-flight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.status(200).end();
    return;
  }
  // --- END CORS FIX ---


  console.log(`--- NEW PORTAL REQUEST: /api/all-stations ---`);

  try {
    // --- 2. FETCH DATA (with 30-minute data cache) ---
    const inlandUrl = "https://publicapi.envir.ee/v1/combinedWeatherData/frontPageWeatherToday";
    const coastalUrl = "https://publicapi.envir.ee/v1/combinedWeatherData/coastalSeaStationsWeatherToday";

    // next: { revalidate: 1800 } tells Vercel to cache the *data*
    // from this fetch for 1800 seconds (30 minutes).
    const [inlandRes, coastalRes] = await Promise.all([
      fetch(inlandUrl, {
        headers: requestHeaders,
        next: { revalidate: 1800 } // 30-minute data cache
      }),
      fetch(coastalUrl, {
        headers: requestHeaders,
        next: { revalidate: 1800 } // 30-minute data cache
      })
    ]);

    if (!inlandRes.ok || !coastalRes.ok) {
      throw new Error(`EMHI Error: Inland=${inlandRes.status}, Coastal=${coastalRes.status}`);
    }

    const inlandData = await inlandRes.json();
    const coastalData = await coastalRes.json();

    const inlandStations = inlandData?.entries?.entry || [];
    const coastalStations = coastalData?.entries?.entry || [];

    const combinedStations = [...inlandStations, ...coastalStations];

    if (combinedStations.length === 0) {
      return res.status(500).json({ error: "STATION_LIST_PARSE_FAIL" });
    }

    // --- 3. CLEAN AND FILTER DATA ---
    const now_unix = Math.floor(Date.now() / 1000);
    const twoHoursAgo_unix = now_unix - (2 * 3600); // 7200 seconds

    const stationMap = new Map();

    for (const station of combinedStations) {
      if (station.Jaam && !stationMap.has(station.Jaam)) {
        if (station.ws10ma !== null && station.wd10ma !== null && station.Time !== null &&
          station.LaiusKraad !== null && station.PikkusKraad !== null) {

          const stationTimestamp_unix = Math.floor(new Date(station.Time).getTime() / 1000);
          if (stationTimestamp_unix >= twoHoursAgo_unix) {
            stationMap.set(station.Jaam, station);
          }
        }
      }
    }

    const cleanStations = Array.from(stationMap.values());

    if (cleanStations.length === 0) {
      console.log("--- No stations found after filtering. ---");
      return res.status(200).json([]); // Return empty array
    }

    console.log(`Found ${cleanStations.length} clean, unique stations. Formatting for portal...`);

    // --- 4. FORMAT FINAL RESPONSE ---
    const portalData = cleanStations.map(station => {
      const stationLat = dmsToDecimal(station.LaiusKraad, station.LaiusMinut, station.LaiusSekund);
      const stationLon = dmsToDecimal(station.PikkusKraad, station.PikkusMinut, station.PikkusSekund);

      // Parse the UTC timestamp string from EMHI
      const observationDate = new Date(station.Time);
      // Format it into Estonian HH:mm time
      const observationTime = estonianTimeFormatter.format(observationDate);

      // Return the clean object
      return {
        name: station.Jaam,
        latitude: stationLat,
        longitude: stationLon,
        wind_speed: parseFloat(station.ws10ma),
        wind_direction: parseFloat(station.wd10ma),
        observation_time: observationTime
      };
    });

    // --- 5. SEND RESPONSE (with 10-minute CDN cache) ---
    console.log(`!!! SUCCESS: Sending ${portalData.length} stations to the portal.`);

    // This s-maxage=600 (10 min) is the *CDN* cache.
    // This is separate from the 30-min *data* cache.
    // This setup is correct and efficient.
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

    return res.status(200).json(portalData);

  } catch (error) {
    console.error("--- CATCH BLOCK ERROR (/api/all-stations) ---");
    console.error(error.message);
    return res.status(500).json({ error: error.message });
  }
}