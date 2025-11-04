// This file replaces /api/wind.js
// It now fetches from *both* inland and coastal APIs

// --- This is the "winning formula" header object ---
const requestHeaders = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
};

// --- Helper function to convert degrees to radians ---
function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

// --- Helper to convert DMS (from EMHI strings) to Decimal ---
function dmsToDecimal(kraad, minut, sekund) {
  const K = parseFloat(kraad);
  const M = parseFloat(minut);
  const S = parseFloat(sekund);
  // Decimal = Degrees + (Minutes / 60) + (Seconds / 3600)
  return K + (M / 60) + (S / 3600);
}

// --- Helper function to calculate distance between two lat/lon points ---
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c; // Distance in km
  return d;
}

// --- Main API Handler ---
export default async function handler(req, res) {
  // 1. Get lat/lon from the Garmin device's query
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing lat/lon parameters" });
  }

  const userLat = parseFloat(lat);
  const userLon = parseFloat(lon);

  console.log(`--- NEW REQUEST: lat=${lat}, lon=${lon} ---`);

  try {
    // --- STEP 1: Make both requests in parallel ---
    const inlandUrl = "https://publicapi.envir.ee/v1/combinedWeatherData/frontPageWeatherToday";
    const coastalUrl = "https://publicapi.envir.ee/v1/combinedWeatherData/coastalSeaStationsWeatherToday";
    
    const [inlandRes, coastalRes] = await Promise.all([
      fetch(inlandUrl, { headers: requestHeaders }),
      fetch(coastalUrl, { headers: requestHeaders })
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
    
    console.log(`Found ${combinedStations.length} total stations. Filtering...`);

    // --- STEP 2: Clean and filter the combined list ---
    const now_unix = Math.floor(Date.now() / 1000);
    const twoHoursAgo_unix = now_unix - (2 * 3600); // 7200 seconds

    const stationMap = new Map();

    for (const station of combinedStations) {
      // 1. Check for duplicates (and only keep the first one)
      if (station.Jaam && !stationMap.has(station.Jaam)) {
        
        // 2. Check for valid data
        if (station.ws10ma !== null && station.wd10ma !== null && station.Time !== null) {
          
          // 3. Check if data is recent (less than 2h old)
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
      return res.status(200).json({ error: "NO_DATA" });
    }

    console.log(`Found ${cleanStations.length} clean, unique stations. Calculating distances...`);

    // --- STEP 3: Calculate distance for every clean station ---
    const stationsWithDistance = cleanStations.map(station => {
      const stationLat = dmsToDecimal(station.LaiusKraad, station.LaiusMinut, station.LaiusSekund);
      const stationLon = dmsToDecimal(station.PikkusKraad, station.PikkusMinut, station.PikkusSekund);
      const distance = getDistance(userLat, userLon, stationLat, stationLon);
      
      return {
        ...station, 
        distance: distance 
      };
    });

    // --- STEP 4: Sort the list by distance (nearest first) ---
    const sortedStations = stationsWithDistance.sort((a, b) => a.distance - b.distance);

    const nearestStation = sortedStations[0];
    
    // --- STEP 5: Your 200km Check ---
    if (nearestStation.distance > 200) {
      console.log(`STEP 5 FAILED: Nearest station '${nearestStation.Jaam}' is ${nearestStation.distance.toFixed(1)} km away (>200km).`);
      return res.status(200).json({ error: "OOR" }); // Out of Range
    }

    // --- STEP 6: Success! Return the data ---
    console.log(`!!! SUCCESS: Found valid data at '${nearestStation.Jaam}' (Distance: ${nearestStation.distance.toFixed(1)} km)`);
    
    const windSpeed = parseFloat(nearestStation.ws10ma);
    const windDir = parseFloat(nearestStation.wd10ma);

    res.setHeader('Cache-Control', 's-maxage=3600'); // Cache for 1 hour
    
    return res.status(200).json({
      windSpeed: windSpeed,
      windDir: windDir,
      stationName: nearestStation.Jaam // We'll send the name
    });

  } catch (error) {
    console.error("--- CATCH BLOCK ERROR ---");
    console.error(error.message);
    return res.status(500).json({ error: error.message });
  }
}

