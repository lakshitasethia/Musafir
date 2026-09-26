def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "ok", "db": "ok", "redis": "ok"}
