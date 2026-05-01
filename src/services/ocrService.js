// src/services/ocrService.js - GOOGLE CLOUD VISION VERSION
import dotenv from 'dotenv';
dotenv.config();


// ============================================
// 🔧 CONFIGURATION
// ============================================
const USE_GOOGLE_VISION = true; // Set to true to use Google Vision (recommended)

// Initialize Google Vision client (if credentials exist)
let visionClient = null;

if (USE_GOOGLE_VISION && process.env.GOOGLE_CREDENTIALS) {
  try {
    const googleCreds = JSON.parse(process.env.GOOGLE_CREDENTIALS);

    visionClient = new vision.ImageAnnotatorClient({
      credentials: googleCreds,
    });

    console.log('✅ Google Cloud Vision initialized');
  } catch (error) {
    console.warn('⚠️ Google Vision init failed:', error.message);
  }
}


/**
 * Preprocess image for better OCR
 */
const preprocessImage = async (imagePath) => {
  try {
    console.log('🖼️  Preprocessing image...');
    
    const ext = path.extname(imagePath);
    const processedPath = imagePath.replace(ext, '_processed.jpg');

    const metadata = await sharp(imagePath).metadata();
    console.log(`📐 Original: ${metadata.width}x${metadata.height}`);

    await sharp(imagePath)
      .rotate() // Auto-rotate based on EXIF
      .resize(2000, 2000, {
        fit: 'inside',
        withoutEnlargement: false,
      })
      .normalize()
      .sharpen()
      .toFile(processedPath);

    console.log('✅ Preprocessed:', processedPath);
    return processedPath;

  } catch (error) {
    console.error('❌ Preprocessing failed:', error.message);
    return imagePath;
  }
};

/**
 * 🔥 GOOGLE CLOUD VISION OCR - Much better for documents!
 */
const extractWithGoogleVision = async (imagePath) => {
  if (!visionClient) {
    throw new Error('Google Vision client not initialized');
  }

  console.log('🌐 Using Google Cloud Vision API...');

  // Read image file
  const imageBuffer = fs.readFileSync(imagePath);

  // Perform text detection
  const [result] = await visionClient.textDetection({
    image: { content: imageBuffer.toString('base64') },
  });

  const detections = result.textAnnotations;
  
  if (!detections || detections.length === 0) {
    console.log('⚠️ No text detected by Google Vision');
    return '';
  }

  // First annotation contains all text
  const fullText = detections[0].description;
  
  console.log(`✅ Google Vision extracted ${fullText.length} characters`);
  console.log(`📝 First 300 chars:\n${fullText.substring(0, 300)}`);
  
  return fullText;
};

/**
 * 🔥 GOOGLE CLOUD VISION DOCUMENT OCR - Even better for structured documents!
 */
const extractWithGoogleDocumentAI = async (imagePath) => {
  if (!visionClient) {
    throw new Error('Google Vision client not initialized');
  }

  console.log('🌐 Using Google Vision Document Text Detection...');

  const imageBuffer = fs.readFileSync(imagePath);

  // Use documentTextDetection for better structured text extraction
  const [result] = await visionClient.documentTextDetection({
    image: { content: imageBuffer.toString('base64') },
  });

  const fullTextAnnotation = result.fullTextAnnotation;
  
  if (!fullTextAnnotation) {
    console.log('⚠️ No document text detected');
    return '';
  }

  const fullText = fullTextAnnotation.text;
  
  console.log(`✅ Document OCR extracted ${fullText.length} characters`);
  console.log(`📝 First 300 chars:\n${fullText.substring(0, 300)}`);
  
  return fullText;
};

/**
 * Fallback to Tesseract.js
 */
const extractWithTesseract = async (imagePath) => {
  console.log('📸 Using Tesseract.js (fallback)...');

  const processedPath = await preprocessImage(imagePath);

  const { data: { text, confidence } } = await Tesseract.recognize(
    processedPath,
    'eng+hin', // English + Hindi
    {
      logger: (m) => {
        if (m.status === 'recognizing text' && Math.round(m.progress * 100) % 20 === 0) {
          console.log(`📊 OCR Progress: ${Math.round(m.progress * 100)}%`);
        }
      },
    }
  );

  console.log(`✅ Tesseract completed, confidence: ${Math.round(confidence)}%`);

  // Cleanup
  if (processedPath !== imagePath && fs.existsSync(processedPath)) {
    try { fs.unlinkSync(processedPath); } catch (e) {}
  }

  return text.trim();
};

/**
 * Main OCR function - tries Google Vision first, falls back to Tesseract
 */
export const extractTextFromImage = async (imagePath, docType = 'generic') => {
  try {
    console.log('\n📸 ========== STARTING OCR ==========');
    console.log('📁 Image:', imagePath);
    console.log('📋 Document type:', docType);

    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }

    let text = '';

    // Try Google Vision first (if available)
    if (USE_GOOGLE_VISION && visionClient) {
      try {
        // Use Document AI for ID cards (better structured text extraction)
        const normalizedType = (docType || '').toLowerCase();
        if (['pan', 'aadhaar', 'aadhar', 'license', 'dl'].includes(normalizedType)) {
          text = await extractWithGoogleDocumentAI(imagePath);
        } else {
          text = await extractWithGoogleVision(imagePath);
        }
        
        if (text && text.length > 20) {
          console.log('✅ Google Vision OCR successful');
          return text;
        }
      } catch (gvError) {
        console.error('⚠️ Google Vision failed:', gvError.message);
      }
    }

    // Fallback to Tesseract
    console.log('⚠️ Falling back to Tesseract.js...');
    text = await extractWithTesseract(imagePath);

    return text;

  } catch (error) {
    console.error('❌ OCR extraction failed:', error);
    throw error;
  }
};

/**
 * Parse extracted text based on document type
 */
export const parseDocumentData = (text, docType) => {
  console.log(`\n🔍 ========== PARSING ${docType.toUpperCase()} ==========`);
  console.log(`📝 Text length: ${text.length}`);
  console.log(`📝 First 500 chars:\n${text.substring(0, 500)}`);

  const normalizedType = (docType || '').toLowerCase().trim();

  let extractedData = {};

  try {
    switch (normalizedType) {
      case 'license':
      case 'driving_license':
      case 'dl':
        extractedData = parseDrivingLicense(text);
        break;

      case 'aadhaar':
      case 'aadhar':
      case 'aadhaar_card':
        extractedData = parseAadhaar(text);
        break;

      case 'pan':
      case 'pan_card':
      case 'pancard':
        extractedData = parsePAN(text);
        break;

      case 'rc':
      case 'registration_certificate':
      case 'vehicle_rc':
        extractedData = parseRC(text);
        break;

      case 'fitnesscertificate':
      case 'fitness_certificate':
      case 'fitness':
      case 'fc':
        extractedData = parseFitnessCertificate(text);
        break;

      case 'insurance':
      case 'insurance_certificate':
        extractedData = parseInsurance(text);
        break;

      case 'permit':
      case 'vehicle_permit':
        extractedData = parsePermit(text);
        break;

      default:
        console.warn('⚠️ Unknown document type:', normalizedType);
        extractedData = { rawText: text.substring(0, 500) };
    }

    // Count extracted fields
    const foundFields = Object.keys(extractedData).filter(k => 
      extractedData[k] && k !== 'rawText' && k !== 'fullRawText'
    );
    
    console.log(`📊 Extracted ${foundFields.length} fields:`, foundFields.join(', '));

    // Save raw text if nothing extracted
    if (foundFields.length === 0) {
      console.warn('⚠️ No fields extracted! Check image quality.');
      extractedData.rawText = text.substring(0, 500);
    }

    return extractedData;

  } catch (error) {
    console.error('❌ Parsing error:', error);
    return { rawText: text.substring(0, 500), parseError: error.message };
  }
};

// ============================================
// 🪪 DRIVING LICENSE PARSER
// ============================================
const parseDrivingLicense = (text) => {
  console.log('🪪 Parsing Driving License...');
  const data = {};
  
  // Clean text
  const cleanText = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ');

  // License Number patterns for Indian DL
  const licensePatterns = [
    /([A-Z]{2}[- ]?\d{2}[- ]?\d{4}[- ]?\d{7})/i, // KA-01-2020-0123456
    /([A-Z]{2}\d{13,14})/i, // KA01202001234567
    /DL[:\s]*(?:No\.?)?[:\s]*([A-Z0-9-]+)/i,
    /License[:\s]*(?:No\.?)?[:\s]*([A-Z0-9-]+)/i,
  ];

  for (const pattern of licensePatterns) {
    const match = text.match(pattern);
    if (match) {
      data.licenseNumber = match[1].replace(/[- ]/g, '').toUpperCase();
      console.log('✅ License Number:', data.licenseNumber);
      break;
    }
  }

  // Name
  const nameMatch = text.match(/Name[:\s]+([A-Z][A-Z\s.]+?)(?=\n|S\/O|D\/O|W\/O|Date|DOB|Father)/i);
  if (nameMatch) {
    data.fullName = nameMatch[1].trim().replace(/\s+/g, ' ');
    console.log('✅ Name:', data.fullName);
  }

  // DOB
  const dobMatch = text.match(/(?:DOB|Date\s*of\s*Birth)[:\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
  if (dobMatch) {
    data.dob = dobMatch[1];
    console.log('✅ DOB:', data.dob);
  }

  // Father's Name
  const fatherMatch = text.match(/(?:S\/O|D\/O|W\/O|Father)[:\s]+([A-Z][A-Z\s.]+?)(?=\n|Address|DOB|$)/i);
  if (fatherMatch) {
    data.fatherOrSpouseName = fatherMatch[1].trim().replace(/\s+/g, ' ');
    console.log('✅ Father Name:', data.fatherOrSpouseName);
  }

  // Address
  const addressMatch = text.match(/Address[:\s]+(.+?)(?=Valid|Expiry|$)/is);
  if (addressMatch) {
    data.address = addressMatch[1].replace(/\n/g, ', ').trim().replace(/\s+/g, ' ').substring(0, 200);
    console.log('✅ Address:', data.address.substring(0, 50) + '...');
  }

  // Validity
  const validityMatch = text.match(/(?:Valid|Validity|Expiry)[:\s]*(?:Till|Upto|To)?[:\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
  if (validityMatch) {
    data.validity = validityMatch[1];
    console.log('✅ Validity:', data.validity);
  }

  // Vehicle Types
  const vehicleTypes = [];
  const upperText = text.toUpperCase();
  if (/\bLMV\b|\bCAR\b|\bMOTOR CAR\b/.test(upperText)) vehicleTypes.push('car');
  if (/\bMCWG\b|\bMC\b|\bMOTORCYCLE\b|\bBIKE\b|\bTWO WHEELER\b/.test(upperText)) vehicleTypes.push('bike');
  if (/\bAUTO\b|\b3W\b|\bTHREE WHEELER\b|\bTRICYCLE\b/.test(upperText)) vehicleTypes.push('auto');
  
  if (vehicleTypes.length > 0) {
    data.vehicleTypes = [...new Set(vehicleTypes)];
    console.log('✅ Vehicle Types:', data.vehicleTypes);
  }

  return data;
};

// ============================================
// 🪪 AADHAAR PARSER
// ============================================
const parseAadhaar = (text) => {
  console.log('🪪 Parsing Aadhaar Card...');
  const data = {};

  // Aadhaar Number (12 digits)
  const aadhaarMatch = text.match(/(\d{4}\s?\d{4}\s?\d{4})/);
  if (aadhaarMatch) {
    data.licenseNumber = aadhaarMatch[1].replace(/\s/g, '');
    console.log('✅ Aadhaar Number:', data.licenseNumber);
  }

  // Name - Look for uppercase name patterns
  const namePatterns = [
    /Name[:\s]+([A-Z][A-Za-z\s.]+?)(?=\n|DOB|Date|जन्म)/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/, // First Last or First Middle Last
  ];

  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match) {
      const name = match[1].trim();
      if (name.length > 3 && !/government|india|aadhaar|uidai/i.test(name)) {
        data.fullName = name;
        console.log('✅ Name:', data.fullName);
        break;
      }
    }
  }

  // DOB
  const dobMatch = text.match(/(?:DOB|Date\s*of\s*Birth|जन्म\s*तिथि)[:\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
  if (dobMatch) {
    data.dob = dobMatch[1];
    console.log('✅ DOB:', data.dob);
  } else {
    // Try any date pattern
    const dateMatch = text.match(/\b(\d{2}[-/]\d{2}[-/]\d{4})\b/);
    if (dateMatch) {
      data.dob = dateMatch[1];
      console.log('✅ DOB (fallback):', data.dob);
    }
  }

  // Gender
  if (/\b(Male|MALE|पुरुष)\b/.test(text)) {
    data.gender = 'Male';
    console.log('✅ Gender:', data.gender);
  } else if (/\b(Female|FEMALE|महिला)\b/.test(text)) {
    data.gender = 'Female';
    console.log('✅ Gender:', data.gender);
  }

  // Address (from back side)
  const addressMatch = text.match(/Address[:\s]+(.+?)(?=\d{6}|PIN|$)/is);
  if (addressMatch) {
    data.address = addressMatch[1].replace(/\n/g, ', ').trim().replace(/\s+/g, ' ').substring(0, 200);
    console.log('✅ Address:', data.address.substring(0, 50) + '...');
  }

  return data;
};

// ============================================
// 💳 PAN CARD PARSER
// ============================================
const parsePAN = (text) => {
  console.log('💳 Parsing PAN Card...');
  const data = {};

  // PAN Number (ABCDE1234F format)
  const panMatch = text.match(/[A-Z]{5}\d{4}[A-Z]/);
  if (panMatch) {
    data.licenseNumber = panMatch[0].toUpperCase();
    console.log('✅ PAN Number:', data.licenseNumber);
  }

  // If not found, try with some common OCR mistakes
  if (!data.licenseNumber) {
    // Sometimes O is recognized as 0, etc.
    const cleanedText = text.replace(/[^A-Z0-9\n]/gi, '');
    const altMatch = cleanedText.match(/[A-Z]{5}\d{4}[A-Z]/);
    if (altMatch) {
      data.licenseNumber = altMatch[0].toUpperCase();
      console.log('✅ PAN Number (cleaned):', data.licenseNumber);
    }
  }

  // Name
  const namePatterns = [
    /Name[:\s]+([A-Z][A-Z\s]+?)(?=\n|Father|Date|$)/i,
    /([A-Z]{2,}(?:\s+[A-Z]{2,}){1,3})(?=\n)/g, // Multiple uppercase words
  ];

  for (const pattern of namePatterns) {
    const matches = text.match(pattern);
    if (matches) {
      const match = Array.isArray(matches) ? matches[0] : matches;
      let name = match.replace(/Name[:\s]*/i, '').trim();
      // Filter out non-names
      if (name.length > 3 && !/INCOME|TAX|GOVERNMENT|INDIA|PERMANENT|ACCOUNT|DEPARTMENT/i.test(name)) {
        data.fullName = name.replace(/\s+/g, ' ');
        console.log('✅ Name:', data.fullName);
        break;
      }
    }
  }

  // DOB
  const dobMatch = text.match(/(?:Date\s*of\s*Birth|DOB)[:\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
  if (dobMatch) {
    data.dob = dobMatch[1];
    console.log('✅ DOB:', data.dob);
  }

  // Father's Name
  const fatherMatch = text.match(/Father['\s]*(?:s)?['\s]*Name[:\s]+([A-Z][A-Z\s]+?)(?=\n|Date|$)/i);
  if (fatherMatch) {
    data.fatherOrSpouseName = fatherMatch[1].trim().replace(/\s+/g, ' ');
    console.log('✅ Father Name:', data.fatherOrSpouseName);
  }

  return data;
};

// ============================================
// 🚗 RC PARSER
// ============================================
const parseRC = (text) => {
  console.log('🚗 Parsing RC...');
  const data = {};

  // Registration Number
  const regMatch = text.match(/[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,2}[-\s]?\d{4}/i);
  if (regMatch) {
    data.licenseNumber = regMatch[0].replace(/[-\s]/g, '').toUpperCase();
    console.log('✅ Registration Number:', data.licenseNumber);
  }

  // Owner Name
  const nameMatch = text.match(/(?:Owner|Name)[:\s]+([A-Z][A-Za-z\s.]+?)(?=\n|Address|Father|$)/i);
  if (nameMatch) {
    data.fullName = nameMatch[1].trim().replace(/\s+/g, ' ');
    console.log('✅ Owner Name:', data.fullName);
  }

  // Engine Number
  const engineMatch = text.match(/Engine[:\s]*(?:No\.?)?[:\s]*([A-Z0-9]+)/i);
  if (engineMatch) {
    data.engineNumber = engineMatch[1];
    console.log('✅ Engine Number:', data.engineNumber);
  }

  // Chassis Number
  const chassisMatch = text.match(/Chassis[:\s]*(?:No\.?)?[:\s]*([A-Z0-9]+)/i);
  if (chassisMatch) {
    data.chassisNumber = chassisMatch[1];
    console.log('✅ Chassis Number:', data.chassisNumber);
  }

  // Model
  const modelMatch = text.match(/(?:Model|Make)[:\s]+([A-Za-z0-9\s-]+?)(?=\n|Engine|$)/i);
  if (modelMatch) {
    data.model = modelMatch[1].trim();
    console.log('✅ Model:', data.model);
  }

  // Validity
  const validityMatch = text.match(/(?:Valid|Tax\s*Valid)[:\s]*(?:Upto|Till)?[:\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
  if (validityMatch) {
    data.validity = validityMatch[1];
    console.log('✅ Validity:', data.validity);
  }

  return data;
};

// ============================================
// 🔧 FITNESS CERTIFICATE PARSER
// ============================================
const parseFitnessCertificate = (text) => {
  console.log('🔧 Parsing Fitness Certificate...');
  const data = {};

  // Registration Number
  const regMatch = text.match(/[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,2}[-\s]?\d{4}/i);
  if (regMatch) {
    data.licenseNumber = regMatch[0].replace(/[-\s]/g, '').toUpperCase();
    console.log('✅ Registration Number:', data.licenseNumber);
  }

  // FC Number
  const fcMatch = text.match(/(?:FC|Fitness)[:\s]*(?:No\.?)?[:\s]*([A-Z0-9/-]+)/i);
  if (fcMatch) {
    data.fcNumber = fcMatch[1];
    console.log('✅ FC Number:', data.fcNumber);
  }

  // Validity
  const validityMatch = text.match(/(?:Valid|Validity)[:\s]*(?:Upto)?[:\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
  if (validityMatch) {
    data.validity = validityMatch[1];
    console.log('✅ Validity:', data.validity);
  }

  return data;
};

// ============================================
// 🛡️ INSURANCE PARSER
// ============================================
const parseInsurance = (text) => {
  console.log('🛡️ Parsing Insurance...');
  const data = {};

  // Policy Number
  const policyMatch = text.match(/(?:Policy|Certificate)[:\s]*(?:No\.?)?[:\s]*([A-Z0-9/-]+)/i);
  if (policyMatch) {
    data.licenseNumber = policyMatch[1];
    console.log('✅ Policy Number:', data.licenseNumber);
  }

  // Company
  const companyMatch = text.match(/(?:Insurer|Company)[:\s]+(.+?)(?=\n|Policy|$)/i);
  if (companyMatch) {
    data.company = companyMatch[1].trim();
    console.log('✅ Company:', data.company);
  }

  // Validity
  const validityMatch = text.match(/(?:Valid|Expiry)[:\s]*(?:Upto|Till)?[:\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
  if (validityMatch) {
    data.validity = validityMatch[1];
    console.log('✅ Validity:', data.validity);
  }

  return data;
};

// ============================================
// 📋 PERMIT PARSER
// ============================================
const parsePermit = (text) => {
  console.log('📋 Parsing Permit...');
  const data = {};

  // Permit Number
  const permitMatch = text.match(/Permit[:\s]*(?:No\.?)?[:\s]*([A-Z0-9/-]+)/i);
  if (permitMatch) {
    data.licenseNumber = permitMatch[1];
    console.log('✅ Permit Number:', data.licenseNumber);
  }

  // Issued By
  const issuedMatch = text.match(/(?:Issued\s*By|Authority)[:\s]+(.+?)(?=\n|Valid|$)/i);
  if (issuedMatch) {
    data.issuedBy = issuedMatch[1].trim();
    console.log('✅ Issued By:', data.issuedBy);
  }

  // Validity
  const validityMatch = text.match(/(?:Valid|Validity)[:\s]*(?:Upto)?[:\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
  if (validityMatch) {
    data.validity = validityMatch[1];
    console.log('✅ Validity:', data.validity);
  }

  return data;
};

export default {
  extractTextFromImage,
  parseDocumentData,
};