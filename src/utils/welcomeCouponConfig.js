const WELCOME_VEHICLE_TYPES = ['all', 'bike', 'auto', 'car', 'premium', 'xl'];

export const normalizeWelcomeVehicleType = (vehicleType) => {
  const normalized = String(vehicleType || 'all').toLowerCase().trim();
  return WELCOME_VEHICLE_TYPES.includes(normalized) ? normalized : 'all';
};

export const normalizeWelcomeFixedAmounts = (fixedAmounts = {}) => {
  const result = {
    all: null,
    bike: null,
    auto: null,
    car: null,
    premium: null,
    xl: null,
  };

  for (const vehicleType of WELCOME_VEHICLE_TYPES) {
    if (vehicleType === 'all') {
      const amount = Number(fixedAmounts?.all);
      result.all = amount > 0 ? amount : null;
      continue;
    }

    const amount = Number(fixedAmounts?.[vehicleType]);
    result[vehicleType] = amount > 0 ? amount : null;
  }

  return result;
};

export const getWelcomeApplicableVehicles = (welcomeCoupon) => {
  const normalizedVehicleType = normalizeWelcomeVehicleType(welcomeCoupon?.vehicleType);

  if (welcomeCoupon?.useFixedWelcomeAmount) {
    const fixedAmounts = normalizeWelcomeFixedAmounts(welcomeCoupon?.fixedAmounts);
    const specificVehicles = WELCOME_VEHICLE_TYPES.filter(
      (vehicleType) => vehicleType !== 'all' && fixedAmounts[vehicleType] > 0
    );

    if (fixedAmounts.all > 0 && specificVehicles.length === 0) {
      return ['all'];
    }

    if (specificVehicles.length > 0) {
      return specificVehicles;
    }
  }

  return [normalizedVehicleType];
};

export const getWelcomeDisplayAmount = (welcomeCoupon, vehicleType = 'all') => {
  if (welcomeCoupon?.useFixedWelcomeAmount) {
    const fixedAmounts = normalizeWelcomeFixedAmounts(welcomeCoupon?.fixedAmounts);
    const normalizedVehicleType = normalizeWelcomeVehicleType(vehicleType);

    if (normalizedVehicleType !== 'all' && fixedAmounts[normalizedVehicleType] > 0) {
      return fixedAmounts[normalizedVehicleType];
    }

    if (fixedAmounts.all > 0) {
      return fixedAmounts.all;
    }

    for (const specificVehicle of WELCOME_VEHICLE_TYPES) {
      if (specificVehicle === 'all') continue;
      if (fixedAmounts[specificVehicle] > 0) {
        return fixedAmounts[specificVehicle];
      }
    }

    const exactAmount = Number(welcomeCoupon?.exactAmount);
    return exactAmount > 0 ? exactAmount : 25;
  }

  const exactAmount = Number(welcomeCoupon?.exactAmount);
  if (exactAmount > 0) return exactAmount;

  const netSaving =
    (Number(welcomeCoupon?.discountAmount) || 0) -
    (Number(welcomeCoupon?.fareAdjustment) || 0);
  return Math.max(netSaving, 0);
};

export const getWelcomeReferenceVehicleType = (welcomeCoupon) => {
  const fixedAmounts = normalizeWelcomeFixedAmounts(welcomeCoupon?.fixedAmounts);
  const specificVehicles = WELCOME_VEHICLE_TYPES.filter(
    (vehicleType) => vehicleType !== 'all' && fixedAmounts[vehicleType] > 0
  );

  if (welcomeCoupon?.useFixedWelcomeAmount) {
    if (fixedAmounts.all > 0 && specificVehicles.length === 0) {
      return 'all';
    }

    if (specificVehicles.length === 1) {
      return specificVehicles[0];
    }

    if (specificVehicles.length > 1) {
      return 'all';
    }
  }

  return normalizeWelcomeVehicleType(welcomeCoupon?.vehicleType);
};
