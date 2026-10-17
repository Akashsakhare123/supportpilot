import { isWidgetRoute } from './app.setup';

describe('isWidgetRoute', () => {
  it('matches widget and public /v1 endpoints only', () => {
    expect(isWidgetRoute('/widget/config')).toBe(true);
    expect(isWidgetRoute('/widget')).toBe(true);
    expect(isWidgetRoute('/widgets')).toBe(false);
    expect(isWidgetRoute('/auth/login')).toBe(false);
    expect(isWidgetRoute('/v1/chat')).toBe(true);
    expect(isWidgetRoute('/chat/playground')).toBe(false);
  });
});
