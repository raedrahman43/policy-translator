/**
 * branding — read a tenant's Microsoft Entra Company Branding and copy it to
 * another tenant. Used by the PROTOTYPE to recreate a customer's *real* B2C
 * sign-in branding in their target Microsoft Entra External ID tenant.
 *
 * Azure AD B2C company branding is limited to background color, banner logo,
 * and background image — all of which map 1:1 onto the External ID
 * `organizationalBranding` resource (same Graph shape on both sides).
 *
 * Read  (source B2C tenant):  GET  /v1.0/organization/{tid}/branding  (Accept-Language: 0)
 *   → returns backgroundColor, signInPageText + relative image URLs + cdnList
 *     (the images are then reachable at public CDN URLs).
 * Write (target External ID): PATCH strings on the default branding, then
 *   PUT the image bytes to the default localization's stream properties.
 */

import { graph, graphGetBinary, graphPutBinary, fetchBytes, GraphError } from "./graphClient";

export interface ImportedBranding {
  hasBranding: boolean;
  backgroundColor?: string;
  signInPageText?: string;
  bannerLogoUrl?: string;
  backgroundImageUrl?: string;
  squareLogoUrl?: string;
  accentColor?: string;
  /** Optional custom CSS (used to approximate a B2C accent/button colour). */
  customCss?: string;
}

function cdnUrl(cdnList: string[] | undefined, relativeUrl: string | undefined | null): string | undefined {
  if (!relativeUrl || !cdnList || !cdnList.length) return undefined;
  const base = cdnList[0];
  return `https://${base}/${relativeUrl}`;
}

/**
 * Read the default company branding from the source tenant. Returns
 * `{ hasBranding: false }` when the tenant has no custom branding configured.
 */
export async function readSourceBranding(tenantId: string, token: string): Promise<ImportedBranding> {
  let b: any;
  try {
    // Accept-Language: 0 selects the default (non-localized) branding.
    b = await graph<any>("GET", `/v1.0/organization/${encodeURIComponent(tenantId)}/branding`, token, undefined, {
      "Accept-Language": "0",
    });
  } catch (err) {
    if (err instanceof GraphError && (err.status === 404 || err.status === 400)) {
      return { hasBranding: false };
    }
    throw err;
  }

  const cdnList: string[] | undefined = b.cdnList;
  const bannerLogoUrl = cdnUrl(cdnList, b.bannerLogoRelativeUrl);
  const backgroundImageUrl = cdnUrl(cdnList, b.backgroundImageRelativeUrl);
  const squareLogoUrl = cdnUrl(cdnList, b.squareLogoRelativeUrl);

  const hasBranding = Boolean(
    (b.backgroundColor && b.backgroundColor !== "#FFFFFF") ||
    bannerLogoUrl || backgroundImageUrl || squareLogoUrl ||
    (b.signInPageText && String(b.signInPageText).trim()),
  );

  const out: ImportedBranding = { hasBranding };
  if (b.backgroundColor) out.backgroundColor = b.backgroundColor;
  if (b.signInPageText) out.signInPageText = b.signInPageText;
  if (bannerLogoUrl) out.bannerLogoUrl = bannerLogoUrl;
  if (backgroundImageUrl) out.backgroundImageUrl = backgroundImageUrl;
  if (squareLogoUrl) out.squareLogoUrl = squareLogoUrl;
  try {
    const css = await graphGetBinary(
      `/v1.0/organization/${encodeURIComponent(tenantId)}/branding/localizations/0/customCSS`,
      token,
    );
    if (css.bytes.length) {
      out.customCss = css.bytes.toString("utf8");
      out.hasBranding = true;
    }
  } catch (err) {
    if (!(err instanceof GraphError) || err.status !== 404) throw err;
  }
  return out;
}

export interface BrandingWriteResult {
  written: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Copy the imported branding onto the target tenant's default branding.
 * String properties are PATCHed; images are downloaded from their public CDN
 * URLs and PUT to the matching stream properties. Best-effort per element:
 * one failing image never aborts the rest.
 */
export async function writeTargetBranding(
  tenantId: string,
  token: string,
  b: ImportedBranding,
): Promise<BrandingWriteResult> {
  const result: BrandingWriteResult = { written: [], skipped: [], errors: [] };
  const orgPath = `/v1.0/organization/${encodeURIComponent(tenantId)}/branding`;

  // 1) Update string properties only when they differ.
  const strings: Record<string, string> = {};
  if (b.backgroundColor) strings.backgroundColor = b.backgroundColor;
  if (b.signInPageText) strings.signInPageText = b.signInPageText;

  if (Object.keys(strings).length) {
    try {
      let current: any = {};
      try {
        current = await graph<any>("GET", orgPath, token, undefined, { "Accept-Language": "0" });
      } catch (err) {
        if (!(err instanceof GraphError) || err.status !== 404) throw err;
      }
      const changed = Object.entries(strings).some(([key, value]) => current[key] !== value);
      if (changed) {
        await graph("PATCH", orgPath, token, strings, { "Accept-Language": "0" });
        result.written.push("colors/text");
      } else {
        result.skipped.push("colors/text (already matched)");
      }
    } catch (err) {
      result.errors.push(`colors/text: ${String(err)}`);
    }
  }

  // 2) Copy images only when their bytes differ from the target stream.
  const images: Array<{ label: string; url: string | undefined; stream: string }> = [
    { label: "banner logo", url: b.bannerLogoUrl, stream: "bannerLogo" },
    { label: "background image", url: b.backgroundImageUrl, stream: "backgroundImage" },
    { label: "square logo", url: b.squareLogoUrl, stream: "squareLogo" },
  ];
  for (const img of images) {
    if (!img.url) { result.skipped.push(img.label); continue; }
    try {
      const { bytes, contentType } = await fetchBytes(img.url);
      const streamPath = `${orgPath}/localizations/0/${img.stream}`;
      let matches = false;
      try {
        const current = await graphGetBinary(streamPath, token);
        matches = current.bytes.equals(bytes);
      } catch (err) {
        if (!(err instanceof GraphError) || err.status !== 404) throw err;
      }
      if (matches) {
        result.skipped.push(`${img.label} (already matched)`);
      } else {
        await graphPutBinary(streamPath, token, bytes, contentType);
        result.written.push(img.label);
      }
    } catch (err) {
      result.errors.push(`${img.label}: ${String(err)}`);
    }
  }

  // 3) Optional custom CSS (approximates a B2C accent / button colour). Written
  //    to the default localization's customCSS stream. Best-effort.
  if (b.customCss && b.customCss.trim()) {
    try {
      const cssBytes = Buffer.from(b.customCss, "utf8");
      if (cssBytes.length > 25 * 1024) throw new Error("custom CSS exceeds the 25 KB Microsoft Graph limit.");
      const cssPath = `${orgPath}/localizations/0/customCSS`;
      let matches = false;
      try {
        const current = await graphGetBinary(cssPath, token);
        matches = current.bytes.equals(cssBytes);
      } catch (err) {
        if (!(err instanceof GraphError) || err.status !== 404) throw err;
      }
      if (matches) {
        result.skipped.push("custom CSS (already matched)");
      } else {
        await graphPutBinary(cssPath, token, cssBytes, "text/css");
        result.written.push("custom CSS (accent)");
      }
    } catch (err) {
      result.errors.push(`custom CSS: ${String(err)}`);
    }
  }

  return result;
}
