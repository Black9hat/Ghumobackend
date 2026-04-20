// src/utils/distanceCalculator.js

/**
 * Calculates the great-circle distance between two points on Earth using Haversine formula.
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lng1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lng2 - Longitude of point 2
 * @returns {number} Distance in kilometers
 */
export const getDistance = (lat1, lng1, lat2, lng2) => {
  const toRad = (value) => (value * Math.PI) / 180;

  const R = 6371; // Radius of Earth in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
};

/**
 * Calculates distance between two [lng, lat] coordinate arrays
 * @param {[number, number]} coords1 - [lng, lat]
 * @param {[number, number]} coords2 - [lng, lat]
 * @returns {number} Distance in meters
 */
export const calculateDistanceInMeters = (coords1, coords2) => {
  const [lng1, lat1] = coords1;
  const [lng2, lat2] = coords2;

  const km = getDistance(lat1, lng1, lat2, lng2);
  return km * 1000;
};
