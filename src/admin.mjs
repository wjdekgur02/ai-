import { connect, passwordDigest } from './store.mjs';

const [email, name] = process.argv.slice(2);
const chunks = [];
for await (const part of process.stdin) chunks.push(part);
const password = Buffer.concat(chunks).toString('utf8').trimEnd();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200 ||
    !name?.trim() || name.length > 60 || password.length < 12 || password.length > 128) {
  console.error('사용법: 비밀번호를 stdin으로 전달하고 npm run admin -- 이메일 이름을 실행하세요. 비밀번호는 12~128자입니다.');
  process.exitCode = 1;
} else {
  const store = connect();
  try {
    store.run("INSERT INTO users(email,name,password,role) VALUES(?,?,?,'admin')",
      email.toLowerCase(), name.trim(), await passwordDigest(password));
    console.log('관리자2 계정을 생성했습니다.');
  } catch (error) {
    if (error.errcode !== 2067) throw error;
    console.error('이미 등록된 이메일입니다.');
    process.exitCode = 1;
  } finally { store.db.close(); }
}
