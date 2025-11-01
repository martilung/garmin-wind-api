// This file replaces /api/wind.js
// We are back to built-in fetch and no external libraries.

// --- This is the "winning formula" header object ---
const requestHeaders = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
};

// --- Helper function to convert degrees to radians ---
function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

// --- Helper function to calculate distance between two lat/lon points ---
// This is the Haversine formula, which returns distance in kilometers
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
    // --- STEP 1: Get the *ENTIRE* list of stations ---
    const url = "https://publicapi.envir.ee/v1/combinedWeatherData/frontPageWeatherToday";
    
    const response = await fetch(url, { headers: requestHeaders });

    if (!response.ok) {
      throw new Error(`EMHI Error: ${response.status}`);
    }
    
    const data = await response.json(); 
    
    // --- THIS IS THE FIX ---
    // The API returns { "entries": { "entry": [ ... ] } }
    const allStations = data?.entries?.entry;
    // --- END OF FIX ---

    if (!allStations || allStations.length === 0) {
      return res.status(500).json({ error: "STATION_LIST_PARSE_FAIL" });
    }
    
    console.log(`Found ${allStations.length} stations. Calculating distances...`);

    // --- STEP 2: Calculate distance for every station ---
    const stationsWithDistance = allStations.map(station => {
      // The API uses 'latitude' and 'longitude' (decimal)
      const stationLat = parseFloat(station.latitude);
      const stationLon = parseFloat(station.longitude);
      
      const distance = getDistance(userLat, userLon, stationLat, stationLon);
      
      return {
        ...station, // Keep all original station data
        distance: distance // Add our new distance field
      };
    });

    // --- STEP 3: Sort the list by distance (nearest first) ---
    const sortedStations = stationsWithDistance.sort((a, b) => a.distance - b.distance);

    // --- STEP 4: Find the nearest station with VALID data ---
    
    // Get the current time (in Unix seconds)
    const now_unix = Math.floor(Date.now() / 1000);
    // Get the timestamp for 2 hours ago
    const twoHoursAgo_unix = now_unix - (2 * 3600); // 3600 seconds/hour

    for (const station of sortedStations) {
      // The timestamp is a Unix timestamp (e.g., 1678886400)
      const stationTimestamp = parseInt(station.timestamp, 10);
      
      // --- Check 1: Is the data recent? ---
      if (stationTimestamp >= twoHoursAgo_unix) {
        
        // --- Check 2: Does it have valid wind data? ---
        // The API uses 'windspeed' and 'winddirection' (numbers)
        if (station.windspeed !== null && station.winddirection !== null) {
          
          // --- SUCCESS! ---
          console.log(`!!! SUCCESS: Found valid data at '${station.name}' (Distance: ${station.distance.toFixed(1)} km)`);
          
          res.setHeader('Cache-Control', 's-maxage=600'); // Cache for 10 minutes
          return res.status(200).json({
            windSpeed: station.windspeed,
            windDir: station.winddirection
          });
        }
      }
    }

    // --- STEP 5: Fail (if loop finishes with no data) ---
    console.log("--- Loop finished. No station found with data newer than 2 hours. ---");
    return res.status(200).json({ error: "NO_DATA" });

  } catch (error) {
    console.error("--- CATCH BLOCK ERROR ---");
    console.error(error.message);
    return res.status(500).json({ error: error.message });
  }
}

