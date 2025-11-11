// --- NEW FILE: /api/all-stations.js ---
// Provides all station data for the web map portal

const requestHeaders = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
};

// --- Helper to convert DMS (from EMHI strings) to Decimal ---
function dmsToDecimal(kraad, minut, sekund) {
  const K = parseFloat(kraad);
  const M = parseFloat(minutes);
  const S = parseFloat(sekund);
  return K + (M / 60) + (S / 3600);
}

// --- Main API Handler for the Web Portal ---
export default async function handler(req, res) {
  console.log(`--- NEW PORTAL REQUEST: /api/all-stations ---`);

  try {
    // --- STEP 1: Make both requests in parallel ---
    const inlandUrl = "https://publicapi.envir.ee/v1/combinedWeatherData/frontPageWeatherToday";
    const coastalUrl = "https://publicapi.envir.ee/v1/combinedWeatherData/coastalSeaStationsWeatherToday";

    // --- CHANGE 1: Add data caching to the fetch calls ---
    // This tells Vercel's Data Cache to store the result of these
    // fetches for 1800 seconds (30 minutes).
    // Your function will not hit EMHI's servers more than once in 30 mins.
    const [inlandRes, coastalRes] = await Promise.all([
      fetch(inlandUrl, {
        headers: requestHeaders,
        next: { revalidate: 1800 } // 30-minute cache
      }),
      fetch(coastalUrl, {
        headers: requestHeaders,
        next: { revalidate: 1800 } // 30-minute cache
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

    console.log(`Found ${combinedStations.length} total stations from cached/fresh data. Filtering...`);

    // --- STEP 2: Clean and filter the combined list ---
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
      return res.status(200).json({ retrieved_at: "N/A", stations: [] });
    }

    console.log(`Found ${cleanStations.length} clean, unique stations. Formatting for portal...`);

    // --- STEP 3: Format the data for the portal ---
    const portalData = cleanStations.map(station => {
      const stationLat = dmsToDecimal(station.LaiusKraad, station.LaiusMinut, station.LaiusSekund);
      const stationLon = dmsToDecimal(station.PikkusKraad, station.PikkusMinut, station.PikkusSekund);

      return {
        name: station.Jaam,
        latitude: stationLat,
        longitude: stationLon,
        wind_speed: parseFloat(station.ws10ma),
        wind_direction: parseFloat(station.wd10ma)
      };
    });

    // --- STEP 4: Success! Get timestamp and return the data ---

    // --- CHANGE 2: Get Estonian time and modify the response structure ---
    const estonianTime = new Intl.DateTimeFormat('et-EE', {
      timeZone: 'Europe/Tallinn',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date());

    console.log(`!!! SUCCESS: Sending ${portalData.length} stations to the portal. Time: ${estonianTime}`);

    // This CDN cache (10 min) is separate from the data cache (30 min).
    // This is good! Users get a fast response from the CDN,
    // and the CDN refetches from your function, which serves cached data.
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

    // Return an object, not an array
    return res.status(200).json({
      retrieved_at: estonianTime,
      stations: portalData
    });

  } catch (error) {
    console.error("--- CATCH BLOCK ERROR (/api/all-stations) ---");
    console.error(error.message);
    return res.status(500).json({ error: error.message });
  }
}