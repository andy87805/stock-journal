// Firebase web 設定值可以公開：它只是專案識別碼，不是密鑰。
// 真正的存取控制在 firestore.rules：每個人只碰得到自己 users/{uid} 底下那份，
// 而且 email 要先被列進 allowlist 才有任何讀寫權限。

// 擁有者的 UID。這個值在 firestore.rules 裡也有一份，兩邊必須一致。
// 放在前端只是為了顯示「開通名單」那個管理畫面，權限判斷仍然在規則那邊，
// 改這裡的值不會給任何人多一分權限。
export const OWNER_UID = "czOCfZWUr5WunUdv5UCpJ9zRPef1";

export const firebaseConfig = {
  apiKey: "AIzaSyC_-O0dSg0NsGFPeIDKc3zCO0bVoPedfxE",
  authDomain: "stock-app-database-3cda4.firebaseapp.com",
  projectId: "stock-app-database-3cda4",
  storageBucket: "stock-app-database-3cda4.firebasestorage.app",
  messagingSenderId: "720011050358",
  appId: "1:720011050358:web:bd49047b0e4eeca1b74e57",
};
