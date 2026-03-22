import { Router } from "express";

const router = Router();

router.get("/privacy", (_req, res) => {
  res.render("pages/privacy", { title: "Privacy Policy — Chefless" });
});

router.get("/terms", (_req, res) => {
  res.render("pages/terms", { title: "Terms of Service — Chefless" });
});

export default router;
