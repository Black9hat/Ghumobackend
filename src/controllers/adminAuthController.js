import jwt from "jsonwebtoken";

const ADMIN_EMAIL = "admin@ghumo.com";
const ADMIN_PASSWORD = "123456"; // change later

export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      return res.status(401).json({
        success: false,
        message: "Invalid admin credentials",
      });
    }

    const token = jwt.sign(
      { email, role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({
      success: true,
      token,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Login failed" });
  }
};
