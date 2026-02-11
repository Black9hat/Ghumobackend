import express from "express";
import { adminLogin } from "../controllers/adminAuthController.js";

const router = express.Router();

// PUBLIC route
router.post("/login", adminLogin);

export default router;
