// zoneController.js
// All zone operations: CRUD, exclusion management, auto-generate from OSM, /check endpoint

import Zone from "../models/zone.js";
import axios from 'axios';

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */

/** Ray-casting point-in-polygon */
function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Overpass API — fetch sub-areas of a place by name */
async function fetchOSMSubAreas(placeName) {
  // Step 1: geocode the place name with Nominatim
  const nomRes = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: {
      q: placeName,
      format: 'json',
      limit: 1,
      addressdetails: 1,
      polygon_geojson: 0,
    },
    headers: { 'User-Agent': 'RideshareAdminPanel/1.0' },
    timeout: 10000,
  });

  if (!nomRes.data?.length) throw new Error(`Place not found: "${placeName}"`);

  const place = nomRes.data[0];
  const osmId   = place.osm_id;
  const osmType = place.osm_type; // node|way|relation

  // Step 2: fetch boundary polygon for the city/state itself
  const boundaryGeoJSON = await fetchBoundaryGeoJSON(osmType, osmId);

  // Step 3: fetch sub-areas (districts / suburbs) via Overpass
  // relation type=boundary admin_level 6–10 inside the parent area
  const overpassQuery = `
    [out:json][timeout:30];
    area(${osmType === 'relation' ? 3600000000 + parseInt(osmId) : parseInt(osmId)})->.parent;
    (
      relation["boundary"="administrative"]["admin_level"~"^[7-9]$"](area.parent);
      relation["place"~"suburb|quarter|neighbourhood|district"](area.parent);
    );
    out tags;
  `;

  let subAreas = [];
  try {
    const ovRes = await axios.post(
      'https://overpass-api.de/api/interpreter',
      `data=${encodeURIComponent(overpassQuery)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 25000 }
    );
    subAreas = ovRes.data?.elements ?? [];
  } catch (e) {
    console.warn('Overpass sub-area fetch failed:', e.message);
  }

  return { place, osmId, osmType, boundaryGeoJSON, subAreas };
}

/** Fetch GeoJSON boundary polygon from Nominatim */
async function fetchBoundaryGeoJSON(osmType, osmId) {
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/lookup', {
      params: {
        osm_ids: `${osmType[0].toUpperCase()}${osmId}`,
        format: 'geojson',
        polygon_geojson: 1,
      },
      headers: { 'User-Agent': 'RideshareAdminPanel/1.0' },
      timeout: 12000,
    });
    return res.data?.features?.[0]?.geometry ?? null;
  } catch { return null; }
}

/** Convert GeoJSON geometry → our Coord[] format */
function geojsonToCoords(geometry) {
  if (!geometry) return null;
  let ring = null;
  if (geometry.type === 'Polygon') {
    ring = geometry.coordinates[0];
  } else if (geometry.type === 'MultiPolygon') {
    // Pick the largest ring
    ring = geometry.coordinates.reduce((best, poly) =>
      poly[0].length > (best?.length ?? 0) ? poly[0] : best, null);
  }
  if (!ring?.length) return null;
  // GeoJSON is [lng, lat]
  return ring.map(([lng, lat]) => ({ lat: +lat.toFixed(6), lng: +lng.toFixed(6) }));
}

/** Fetch polygon for a single OSM relation */
async function fetchRelationPolygon(osmRelationId) {
  const geo = await fetchBoundaryGeoJSON('relation', osmRelationId);
  return geojsonToCoords(geo);
}

/* ─────────────────────────────────────────────────────────────
   AUTO-GENERATE CLUSTERS
───────────────────────────────────────────────────────────── */
export const autoGenerateClusters = async (req, res) => {
  const { placeName } = req.body;
  if (!placeName?.trim()) return res.status(400).json({ message: 'placeName is required' });

  try {
    const { place, osmId, osmType, boundaryGeoJSON, subAreas } = await fetchOSMSubAreas(placeName.trim());

    const cityName    = place.display_name.split(',')[0].trim();
    const cityCoords  = geojsonToCoords(boundaryGeoJSON);

    // Check if a city zone already exists
    let cityZone = await Zone.findOne({ osmId: String(osmId), type: 'city' });

    if (!cityZone && cityCoords) {
      cityZone = await Zone.create({
        name: cityName,
        type: 'city',
        polygon: cityCoords,
        osmId: String(osmId),
        osmType,
        serviceEnabled: true,
      });
    }

    // Build sub-area clusters in parallel (max 20 to avoid rate-limits)
    const topSubAreas = subAreas.slice(0, 20);
    const clusterResults = [];
    const existingNames = new Set();

    for (const sub of topSubAreas) {
      const subName = sub.tags?.['name:en'] || sub.tags?.name;
      if (!subName || existingNames.has(subName)) continue;
      existingNames.add(subName);

      // Skip if cluster already exists
      const exists = await Zone.findOne({ name: subName, type: 'cluster', parentId: cityZone?._id });
      if (exists) { clusterResults.push(exists); continue; }

      // Fetch polygon for this sub-area relation
      const coords = await fetchRelationPolygon(sub.id);
      if (!coords || coords.length < 3) continue;

      const cluster = await Zone.create({
        name: subName,
        type: 'cluster',
        parentId: cityZone?._id ?? null,
        polygon: coords,
        osmId: String(sub.id),
        osmType: 'relation',
        serviceEnabled: true,
      });
      clusterResults.push(cluster);

      // Small delay to be polite to OSM servers
      await new Promise(r => setTimeout(r, 350));
    }

    res.json({
      success: true,
      city: cityZone,
      clusters: clusterResults,
      message: `Generated ${clusterResults.length} cluster(s) for ${cityName}`,
    });
  } catch (e) {
    console.error('autoGenerateClusters error:', e.message);
    res.status(500).json({ message: e.message || 'Failed to generate clusters' });
  }
};

/* ─────────────────────────────────────────────────────────────
   STANDARD CRUD
───────────────────────────────────────────────────────────── */
export const getZones = async (req, res) => {
  try {
    const zones = await Zone.find().sort({ createdAt: -1 });
    res.json({ success: true, data: zones });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const createZone = async (req, res) => {
  try {
    const zone = await Zone.create(req.body);
    res.status(201).json({ success: true, data: zone });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

export const updateZone = async (req, res) => {
  try {
    const zone = await Zone.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!zone) return res.status(404).json({ message: 'Zone not found' });
    res.json({ success: true, data: zone });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

export const deleteZone = async (req, res) => {
  try {
    const zone = await Zone.findByIdAndDelete(req.params.id);
    if (!zone) return res.status(404).json({ message: 'Zone not found' });
    // Also delete child clusters/areas
    await Zone.deleteMany({ parentId: req.params.id });
    res.json({ success: true, message: 'Deleted' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/* ─────────────────────────────────────────────────────────────
   EXCLUSION ZONES
───────────────────────────────────────────────────────────── */
export const addExclusionZone = async (req, res) => {
  try {
    const zone = await Zone.findByIdAndUpdate(
      req.params.id,
      { $push: { exclusionZones: req.body } },
      { new: true }
    );
    if (!zone) return res.status(404).json({ message: 'Zone not found' });
    res.json({ success: true, data: zone });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

export const removeExclusionZone = async (req, res) => {
  try {
    const zone = await Zone.findByIdAndUpdate(
      req.params.id,
      { $pull: { exclusionZones: { _id: req.params.exclusionId } } },
      { new: true }
    );
    if (!zone) return res.status(404).json({ message: 'Zone not found' });
    res.json({ success: true, data: zone });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/* ─────────────────────────────────────────────────────────────
   /check — Customer app service availability
   Priority: exclusion > cluster > city
───────────────────────────────────────────────────────────── */
export const checkServiceAvailability = async (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ message: 'lat and lng required' });

  try {
    const zones = await Zone.find({ serviceEnabled: true });

    let matchedZone = null;
    let priority = 0; // higher = better match

    for (const zone of zones) {
      if (!pointInPolygon(lat, lng, zone.polygon)) continue;

      // Check if inside any exclusion zone → blocked
      const inExclusion = (zone.exclusionZones ?? []).some(ex =>
        pointInPolygon(lat, lng, ex.polygon)
      );
      if (inExclusion) {
        return res.json({ serviceAvailable: false, reason: 'exclusion_zone', zoneName: zone.name });
      }

      // Priority: cluster (2) > city (1) > area (0)
      const p = zone.type === 'cluster' ? 2 : zone.type === 'city' ? 1 : 0;
      if (p > priority) { priority = p; matchedZone = zone; }
    }

    if (!matchedZone) {
      return res.json({ serviceAvailable: false, reason: 'outside_coverage' });
    }

    res.json({
      serviceAvailable: true,
      zoneName:         matchedZone.name,
      zoneType:         matchedZone.type,
      surgeMultiplier:  matchedZone.surgeMultiplier,
      driverIncentive:  matchedZone.driverIncentive,
      vehicleTypes:     matchedZone.vehicleTypes,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};
