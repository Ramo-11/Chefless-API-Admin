import { Router } from "express";
import { unsubscribeContact } from "../admin/controllers/early-access";

const router = Router();

router.get("/privacy", (_req, res) => {
  res.render("pages/privacy", { title: "Privacy Policy — Chefless" });
});

router.get("/terms", (_req, res) => {
  res.render("pages/terms", { title: "Terms of Service — Chefless" });
});

// Public one-click unsubscribe for early-access marketing emails. Supports
// GET (link click) and POST (RFC 8058 List-Unsubscribe-Post header).
router.get("/email/unsubscribe", unsubscribeContact);
router.post("/email/unsubscribe", unsubscribeContact);

export default router;
