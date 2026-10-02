import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Smoke gọi docker CLI bằng `execFileSync` (smoke-support `compose`/`psql`/`logsSince`), mỗi lần chặn event loop vài
 * giây, nhiều lần liền nhau. Trong lúc đó api đóng socket keep-alive rảnh (Node: keepAliveTimeout 5 s, hint
 * `Keep-Alive: timeout=5`) nhưng undici không xử lý được FIN cũng như timer keep-alive của chính nó, nên `fetch` kế
 * tiếp ghi request lên socket đã bị đóng phía bên kia → `SocketError: other side closed` (nightly smoke trên Linux;
 * trace undici: request gửi trên socket cũ 7 ms trước khi sự kiện `end` của nó được xử lý).
 *
 * Smoke đóng vai ingress chứ không kiểm tra keep-alive, nên không giữ kết nối giữa các request: `pipelining: 0` tắt
 * keep-alive của undici, mỗi request một kết nối mới. `setGlobalDispatcher` cũng gắn dispatcher này cho `fetch` có sẵn
 * của Node (Symbol.for('undici.globalDispatcher.1')).
 */
setGlobalDispatcher(new Agent({ pipelining: 0 }));
