/**
 * Premium access considers both the subscription flag and optional expiry.
 */
export function hasActivePremium(user: {
  isPremium: boolean;
  premiumExpiresAt?: Date | null;
}): boolean {
  if (!user.isPremium) return false;
  if (!user.premiumExpiresAt) return true;
  return new Date(user.premiumExpiresAt) > new Date();
}
