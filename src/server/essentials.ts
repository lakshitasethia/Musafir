/**
 * Travel essentials: real accommodation near a trip, from OpenStreetMap.
 * OSM has names, locations and sometimes a `stars` tag — never prices or
 * availability — so booking is a hand-off and prices are never shown here.
 */
import { HttpError, type SessionUser } from "./auth.ts";
import { nearbyCandidates, searchPlaces } from "./osm.ts";
import { getTripBundle } from "./trips.ts";

const HOTEL_RADIUS_M = 2500;

export async function hotelsForTrip(user: SessionUser, tripId: string) {
  const { trip } = await getTripBundle(user, tripId);
  const stops = trip.schedule.flatMap((d) => d.nodes);
  let center: { lat: number; lng: number } | null = stops.length
    ? { lat: stops.reduce((s, n) => s + n.location.lat, 0) / stops.length, lng: stops.reduce((s, n) => s + n.location.lng, 0) / stops.length }
    : null;
  let basis = "the middle of your planned stops";
  if (!center) {
    const [place] = await searchPlaces(trip.destination);
    if (!place) throw new HttpError(422, `Couldn't find "${trip.destination}" on the map`);
    center = { lat: place.lat, lng: place.lng };
    basis = `the centre of ${trip.destination}`;
  }
  const hotels = await nearbyCandidates(center, "ACCOMMODATION", HOTEL_RADIUS_M);
  return {
    destination: trip.destination,
    dateRange: trip.dateRange,
    basis,
    hotels: hotels.slice(0, 20).map((h) => ({
      id: h.osmId,
      name: h.nameEn ?? h.name,
      nameNative: h.nameEn ? h.name : undefined,
      lat: h.lat,
      lng: h.lng,
      kind: h.kind.split("=")[1] ?? h.kind,
      distanceMeters: h.distanceMeters,
      stars: h.stars,
      website: h.website,
      source: h.source,
    })),
  };
}
