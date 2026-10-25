import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";

import {
  getDatabase
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

import {
  getAuth
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBUbfA0psNfIyXvI-dc7Q36Hly3QM5Ejhg",
  authDomain: "trackly-project-8713f.firebaseapp.com",
  databaseURL: "https://trackly-project-8713f-default-rtdb.firebaseio.com",
  projectId: "trackly-project-8713f",
  storageBucket: "trackly-project-8713f.firebasestorage.app",
  messagingSenderId: "468382376699",
  appId: "1:468382376699:web:a5753f3d35fa9ca912065e",
  measurementId: "G-0WWZKJ7KC4"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getDatabase(app);