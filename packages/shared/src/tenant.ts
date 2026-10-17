/** Per-tenant widget branding (edited in T03, applied by the widget in T08). */
export interface TenantBranding {
  primaryColor?: string;
  logoUrl?: string;
  greeting?: string;
  position?: 'right' | 'left';
}
