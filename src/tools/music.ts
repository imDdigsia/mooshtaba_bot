/**
 * Music search via Apple's public iTunes Search API. No key required.
 * Docs: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html
 */
import type { Config } from "../config.js";
import { fetchWithRetry } from "../utils/fetch.js";

const BASE = "https://itunes.apple.com/search";

export interface SongResult {
  kind: "song";
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName?: string;
  collectionId?: number;
  releaseDate?: string;
  primaryGenreName?: string;
  trackTimeMillis?: number;
  trackViewUrl?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
}

export interface ArtistResult {
  kind: "artist";
  artistId: number;
  artistName: string;
  primaryGenreName?: string;
  artistLinkUrl?: string;
}

export interface AlbumResult {
  kind: "album";
  collectionId: number;
  collectionName: string;
  artistName: string;
  releaseDate?: string;
  primaryGenreName?: string;
  trackCount?: number;
  collectionViewUrl?: string;
  artworkUrl100?: string;
}

export type MusicResult = SongResult | ArtistResult | AlbumResult;

interface ItunesSong {
  wrapperType: "track";
  kind: "song";
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName?: string;
  collectionId?: number;
  releaseDate?: string;
  primaryGenreName?: string;
  trackTimeMillis?: number;
  trackViewUrl?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
}
interface ItunesArtist {
  wrapperType: "artist";
  artistId: number;
  artistName: string;
  primaryGenreName?: string;
  artistLinkUrl?: string;
}
interface ItunesAlbum {
  wrapperType: "collection";
  collectionId: number;
  collectionName: string;
  artistName: string;
  releaseDate?: string;
  primaryGenreName?: string;
  trackCount?: number;
  collectionViewUrl?: string;
  artworkUrl100?: string;
}
interface ItunesResponse<T> {
  resultCount: number;
  results: T[];
}

async function itunesGet<T>(params: Record<string, string | number>): Promise<T[]> {
  const url = new URL(BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetchWithRetry(url.toString(), {
    timeoutMs: 10_000,
    retries: 2,
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`);
  const j = (await res.json()) as ItunesResponse<T>;
  return j.results ?? [];
}

export async function searchMusic(cfg: Config, query: string, limit = 3): Promise<SongResult[]> {
  void cfg;
  const rows = await itunesGet<ItunesSong>({ term: query, entity: "song", limit });
  return rows.map((r) => ({
    kind: "song",
    trackId: r.trackId,
    trackName: r.trackName,
    artistName: r.artistName,
    collectionName: r.collectionName,
    collectionId: r.collectionId,
    releaseDate: r.releaseDate,
    primaryGenreName: r.primaryGenreName,
    trackTimeMillis: r.trackTimeMillis,
    trackViewUrl: r.trackViewUrl,
    previewUrl: r.previewUrl,
    artworkUrl100: r.artworkUrl100,
    artworkUrl60: r.artworkUrl60,
  }));
}

export async function searchArtist(cfg: Config, query: string, limit = 3): Promise<ArtistResult[]> {
  void cfg;
  const rows = await itunesGet<ItunesArtist>({ term: query, entity: "musicArtist", limit });
  return rows.map((r) => ({
    kind: "artist",
    artistId: r.artistId,
    artistName: r.artistName,
    primaryGenreName: r.primaryGenreName,
    artistLinkUrl: r.artistLinkUrl,
  }));
}

export async function searchAlbum(cfg: Config, query: string, limit = 3): Promise<AlbumResult[]> {
  void cfg;
  const rows = await itunesGet<ItunesAlbum>({ term: query, entity: "album", limit });
  return rows.map((r) => ({
    kind: "album",
    collectionId: r.collectionId,
    collectionName: r.collectionName,
    artistName: r.artistName,
    releaseDate: r.releaseDate,
    primaryGenreName: r.primaryGenreName,
    trackCount: r.trackCount,
    collectionViewUrl: r.collectionViewUrl,
    artworkUrl100: r.artworkUrl100,
  }));
}
