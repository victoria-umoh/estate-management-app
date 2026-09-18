/**
 * Private document storage.
 *
 * Resident documents — NIN slips, leases, vehicle papers, incident photos — are
 * never served from a public URL. Every read goes through a short-lived
 * presigned URL issued only after a permission check, so the object store is
 * not itself an access-control boundary that can be misconfigured open.
 */
export interface StoredObject {
  /** Storage key. Not a URL, and never guessable from user input. */
  key: string;
  size: number;
  contentType: string;
  checksum: string;
}

export interface UploadInput {
  /** Caller-supplied path prefix, e.g. `estate-1/residents/r-1`. */
  prefix: string;
  filename: string;
  contentType: string;
  body: Buffer;
}

export interface StorageAdapter {
  upload(input: UploadInput): Promise<StoredObject>;
  /** Time-limited download URL. The URL itself is a bearer credential. */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
