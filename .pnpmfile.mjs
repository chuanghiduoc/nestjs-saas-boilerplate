// Hook readPackage của pnpm (https://pnpm.io/pnpmfile): sửa manifest của dependency trước khi resolve.
//
// Ruling S2-R5: better-auth khai `vitest` là peer tuỳ chọn (chỉ `better-auth/test-utils` dùng; app
// không import). Vì `vitest` có trong devDependencies ở gốc, pnpm nối peer đó vào snapshot của
// better-auth, nên `pnpm prune --prod` giữ cả chuỗi vitest/vite/rolldown/lightningcss (~38 MB) trong
// image production. `peerDependencyRules` chỉ tắt cảnh báo, `packageExtensions` chỉ thêm được chứ không
// xoá được peer; bỏ peer ở đây là cách pnpm tài liệu hoá để đổi manifest của dependency.
/** Peer tuỳ chọn bị bỏ khỏi manifest của từng package (tên package → tên peer). */
const DROPPED_OPTIONAL_PEERS = { 'better-auth': ['vitest'] };

function readPackage(pkg, context) {
  const dropped = DROPPED_OPTIONAL_PEERS[pkg.name] ?? [];
  for (const peer of dropped) {
    if (!pkg.peerDependencies?.[peer]) continue;
    // Chỉ bỏ peer tuỳ chọn: bỏ một peer bắt buộc sẽ làm hỏng package lúc chạy.
    if (pkg.peerDependenciesMeta?.[peer]?.optional !== true)
      throw new Error(
        `.pnpmfile.mjs: ${pkg.name}@${pkg.version} peer "${peer}" is no longer optional; review ruling S2-R5`,
      );
    delete pkg.peerDependencies[peer];
    delete pkg.peerDependenciesMeta[peer];
    context.log(
      `dropped optional peer ${peer} of ${pkg.name}@${pkg.version} (ruling S2-R5)`,
    );
  }
  return pkg;
}

export const hooks = { readPackage };
