/**
 * Mirror customer-app menu bucket logic for server-side drink eligibility (loyalty rewards).
 */

const OTHER_SLUG = 'other';

function menuBucketSlugForSquareCategory(squareCategoryName) {
  if (!squareCategoryName) return OTHER_SLUG;
  const n = String(squareCategoryName).toLowerCase();

  if (n.includes('matcha')) return 'matcha';
  if (n.includes('pastry') || n.includes('pastries')) return 'pastries';

  const isCold = n.includes('cold') || n.includes('iced');
  const isHot = n.includes('hot') && !isCold;

  if (isCold && (n.includes('coffee') || n.includes('drink') || n.includes('tea'))) {
    return 'iced-drinks';
  }
  if (isHot && (n.includes('coffee') || n.includes('drink') || n.includes('tea'))) {
    return 'hot-drinks';
  }
  if (isCold) return 'iced-drinks';
  if (isHot) return 'hot-drinks';

  return OTHER_SLUG;
}

function isDrinkMenuBucket(slug) {
  return slug === 'matcha' || slug === 'hot-drinks' || slug === 'iced-drinks';
}

function catalogItemIsDrink(item) {
  if (!item) return false;
  const slug = menuBucketSlugForSquareCategory(item.categoryName);
  return isDrinkMenuBucket(slug);
}

module.exports = {
  menuBucketSlugForSquareCategory,
  isDrinkMenuBucket,
  catalogItemIsDrink,
  OTHER_SLUG,
};
