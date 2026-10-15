export async function login(username, password) {
  const response = await fetch("/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return response.json();
}
