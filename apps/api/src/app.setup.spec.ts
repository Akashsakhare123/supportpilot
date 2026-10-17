import { isWidgetRoute } from './app.setup';

describe('isWidgetRoute', () => {
  it('matches widget endpoints only', () => {
    expect(isWidgetRoute('/widget/config')).toBe(true);
    expect(isWidgetRoute('/widget')).toBe(true);
    expect(isWidgetRoute('/widgets')).toBe(false);
    expect(isWidgetRoute('/auth/login')).toBe(false);
  });
});
