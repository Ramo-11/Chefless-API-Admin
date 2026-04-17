import "dotenv/config";
import * as readline from "readline";
import mongoose from "mongoose";
import AdminUser from "../models/AdminUser";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/chefless";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function seedAdmin() {
  const email = await prompt("Email: ");
  if (!email) {
    console.error("Email is required.");
    process.exit(1);
  }

  const name = await prompt("Name: ");
  if (!name) {
    console.error("Name is required.");
    process.exit(1);
  }

  const password = await prompt("Password (min 8 chars): ");
  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const roleInput = await prompt("Role (super_admin / admin) [super_admin]: ");
  const role = roleInput === "admin" ? "admin" : "super_admin";

  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB");

  const existing = await AdminUser.findOne({ email: email.toLowerCase() });
  if (existing) {
    console.error(`An admin with email "${email}" already exists.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  await AdminUser.create({
    email: email.toLowerCase(),
    password,
    name,
    role,
    isActive: true,
  });

  console.log(`Admin created: ${email} (${role})`);
  await mongoose.disconnect();
}

seedAdmin().catch((err) => {
  console.error("Failed to seed admin:", err);
  process.exit(1);
});
