# Avengers Pets

Little desktop pets that live on your screen: Spider-Man, Iron Man, Captain America, Hulk, Thor, Black Widow, Hawkeye, Doctor Strange and Mochi. They wander, fly, swing on webs, throw shields and hammers, open portals, chat when they meet, and knock each other around.

Fan-made for fun. The Marvel characters belong to Marvel.

## What's here

| File | What it is |
|---|---|
| `avengers-pets.js` | The main app (Linux, GNOME). All nine pets with a panel to choose who stays. |
| `spidey.js` | The earlier standalone Spider-Man pet (Linux, GNOME). |
| `pocket-pet.js` | The earlier standalone Mochi pet (Linux, GNOME). |
| `pocket-pet.html` | Mochi as a web page you can open in any browser. |
| `spidey-pet.zip` | Spider-Man packaged with an installer, for sharing with Linux users. |
| `spidey-pet-windows.zip` | Spider-Man for Windows 10/11. Unzip and double-click `Start Spidey.bat`. |

## Run it (Linux with GNOME)

Needs `gjs`, which comes with GNOME (`sudo apt install gjs` if it's missing).

```bash
gjs -m avengers-pets.js
```

Run it again while it's open to bring back the panel where you switch pets on and off.

## Play

- **Click** a pet for a trick.
- **Drag** to pick one up and toss it.
- **Right-click** for that pet's own moves, to make it stay put, send it home, or put everyone away.
