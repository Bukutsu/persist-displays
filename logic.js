export function normalizePrimary(values) {
    const primaryIndex = Math.max(0, values.findIndex(Boolean));
    return values.map((_value, index) => index === primaryIndex);
}

export function profileMatchesMonitor(profile, monitorSpec) {
    if (!monitorSpec)
        return false;

    const identity = ['vendor', 'product', 'serial'];
    if (!identity.some(property => Object.hasOwn(profile, property)))
        return true;

    return identity.every((property, index) => profile[property] === monitorSpec[index + 1]);
}
