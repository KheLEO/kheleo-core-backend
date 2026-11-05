import { GeoPoint } from './postgis-spatial.repository';

const EARTH_RADIUS_KM = 6371;
const DEGREES = 180 / Math.PI;

export interface GeoBoundingBox {
  readonly minLat: number;
  readonly maxLat: number;
  readonly west: number;
  readonly east: number;
  readonly allLongitudes: boolean;
  readonly crossesAntimeridian: boolean;
}

export function haversineDistance(point: GeoPoint, lat: number, lng: number): number {
  const lat1 = point.lat / DEGREES;
  const lat2 = lat / DEGREES;
  const halfLat = (lat2 - lat1) / 2;
  const halfLng = (lng - point.lng) / DEGREES / 2;
  const a = Math.sin(halfLat) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(halfLng) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export function geographicBoundingBox(point: GeoPoint, radiusKm: number): GeoBoundingBox {
  const angle = radiusKm / EARTH_RADIUS_KM;
  const minLat = Math.max(-90, point.lat - angle * DEGREES - 1e-9);
  const maxLat = Math.min(90, point.lat + angle * DEGREES + 1e-9);
  if (minLat <= -90 || maxLat >= 90)
    return {
      minLat,
      maxLat,
      west: -180,
      east: 180,
      allLongitudes: true,
      crossesAntimeridian: false,
    };
  const deltaLng =
    Math.asin(Math.min(1, Math.sin(angle) / Math.cos(point.lat / DEGREES))) * DEGREES + 1e-9;
  const rawWest = point.lng - deltaLng;
  const rawEast = point.lng + deltaLng;
  const normalize = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180;
  return {
    minLat,
    maxLat,
    west: normalize(rawWest),
    east: normalize(rawEast),
    allLongitudes: false,
    crossesAntimeridian: rawWest <= -180 || rawEast >= 180,
  };
}
