import { describe, expect, it } from 'vitest';
import { configRegistry } from '../../../../src/core/config/index.js';
import { NotificationsModule } from '../../../../src/modules/notifications/index.js';

describe('NotificationsModule', () => {
  it('importing the module registers the notifications and smtp config, so validateAllConfigs checks them at boot', () => {
    expect(NotificationsModule.forApi().global).toBe(true);
    const namespaces = configRegistry().map((e) => e.namespace);
    expect(namespaces).toEqual(
      expect.arrayContaining(['notifications', 'smtp']),
    );
  });
});
