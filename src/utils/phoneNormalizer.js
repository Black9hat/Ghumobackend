/**
 * 📱 Consistent phone normalization utility
 * Ensures all phone numbers are stored and queried in the same format
 */

/**
 * Normalize phone number to 10-digit format
 * Removes +91, 91 prefix and any non-digit characters, takes last 10 digits
 * @param {string} phone - Raw phone number
 * @returns {string} Normalized 10-digit phone number
 */
export const normalizePhone = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return null;
  }
  
  // Remove +91 or 91 prefix first
  let normalized = phone.replace(/^\+91/, '').replace(/^91/, '');
  
  // Remove all non-digit characters
  normalized = normalized.replace(/\D/g, '');
  
  // Take last 10 digits to handle edge cases
  normalized = normalized.slice(-10);
  
  // Validate: should be exactly 10 digits
  if (!/^\d{10}$/.test(normalized)) {
    console.warn(`⚠️ Phone normalization resulted in invalid format: "${phone}" -> "${normalized}"`);
    return null;
  }
  
  return normalized;
};

/**
 * Validate if a string is a valid MongoDB ObjectID
 * @param {string} id - ID to validate
 * @returns {boolean}
 */
export const isValidObjectId = (id) => {
  return /^[0-9a-f]{24}$/.test(id);
};