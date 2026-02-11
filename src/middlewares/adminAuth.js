import jwt from "jsonwebtoken";

export const verifyAdminToken = (req, res, next) => {
  try {
    let token = null;
    
    // ✅ Option 1: From Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }
    
    // ✅ Option 2: From query parameter (for image requests from <img src>)
    if (!token && req.query.token) {
      token = req.query.token;
    }
    
    if (!token) {
      console.log("❌ No admin token provided");
      console.log("   Headers:", req.headers.authorization ? "Has Auth Header" : "No Auth Header");
      console.log("   Query token:", req.query.token ? "Has Query Token" : "No Query Token");
      return res.status(401).json({ 
        success: false, 
        message: "Access denied. No token provided." 
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.role !== "admin") {
      console.log("❌ Token is not an admin token, role:", decoded.role);
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. Admin privileges required." 
      });
    }
    
    req.admin = decoded;
    next();
    
  } catch (error) {
    console.error("❌ Admin token verification failed:", error.message);
    return res.status(401).json({ 
      success: false, 
      message: "Invalid or expired token." 
    });
  }
};