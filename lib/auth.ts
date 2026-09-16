import { prisma } from "@/lib/db";
import type { User } from "@prisma/client";

// The authentication built in Assessment 1 is not part of this repository, so
// this slice ships a minimal signed-in shell for the real user. Swap
// `getCurrentUser` for the real auth session in production. This reuse is
// documented per the assessment brief ("Reuse is not cheating; hiding it is.").

const DEV_USER = Object.freeze({
  id: "adegbesanjoshua9",
  email: "adegbesanjoshua9@gmail.com",
  name: "Adegbesan Joshua",
} as const);

export async function getCurrentUser(): Promise<User> {
  return prisma.user.upsert({
    where: { id: DEV_USER.id },
    update: {
      name: DEV_USER.name,
      email: DEV_USER.email,
    },
    create: DEV_USER,
  });
}

export function getDevUser() {
  return DEV_USER;
}
