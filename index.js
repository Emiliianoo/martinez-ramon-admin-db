require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const port = process.env.PORT || 3000;
const hostname = process.env.HOSTNAME || "127.0.0.1";

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

app.use(express.json());

app.post("/api/products", (req, res) => {
  const { name, description, price, stock, image } = req.body;

  if (!name || !description || !price || !stock || !image) {
    return res.status(400).send("Faltan datos del producto");
  }

  const sql =
    "INSERT INTO products (name, description, price, stock, image, created_at) VALUES (?, ?, ?, ?, ?, NOW())";

  pool
    .query(sql, [name, description, price, stock, image])
    .then(([result]) => {
      res
        .status(201)
        .json({ id: result.insertId, name, description, price, stock, image });
    })
    .catch((error) => {
      console.error(error);
      res.status(500).send("Error al agregar el producto");
    });
});

app.delete("/api/products/:id", (req, res) => {
  const { id } = req.params;
  const sql = "DELETE FROM products WHERE id = ?";

  pool
    .query(sql, [id])
    .then(([result]) => {
      if (result.affectedRows === 0) {
        return res.status(404).send("Producto no encontrado");
      }
      res.status(200).send("Producto eliminado exitosamente");
    })
    .catch((error) => {
      console.error(error);
      res.status(500).send("Error al eliminar el producto");
    });
});

app.put("/api/products/:id", (req, res) => {
  const { id } = req.params;
  const { name, description, price, stock, image } = req.body;

  if (!name || !description || !price || !stock || !image) {
    return res.status(400).send("Faltan datos del producto");
  }

  const sql =
    "UPDATE products SET name = ?, description = ?, price = ?, stock = ?, image = ? WHERE id = ?";

  pool
    .query(sql, [name, description, price, stock, image, id])
    .then(([result]) => {
      if (result.affectedRows === 0) {
        return res.status(404).send("Producto no encontrado");
      }
      res.status(200).json({ id, name, description, price, stock, image });
    })
    .catch((error) => {
      console.error(error);
      res.status(500).send("Error al actualizar el producto");
    });
});

app.get("/api/products", (req, res) => {
  const sql = "SELECT * FROM products";
  pool
    .query(sql)
    .then(([rows]) => {
      res.status(200).json(rows);
    })
    .catch((error) => {
      console.error(error);
      res.status(500).send("Error al consultar los productos");
    });
});

// Crear una nueva compra junto con sus detalles asociados
app.post("/api/purchases", (req, res) => {
  const { user_id, status, details } = req.body;

  if (
    !user_id ||
    !status ||
    !details ||
    !Array.isArray(details) ||
    details.length === 0
  ) {
    return res
      .status(400)
      .send("Faltan datos de la compra o detalles inválidos");
  }

  // Mínimo debe haber un producto en la compra

  // No se pueden guardar más de 5 productos por compra
  if (details.length > 5) {
    return res
      .status(400)
      .send("No se pueden comprar más de 5 productos por compra");
  }

  // Validar que haya stock disponible en cada producto
  const checkStockPromises = details.map((item) =>
    pool.query("SELECT stock FROM products WHERE id = ?", [item.product_id])
  );

  Promise.all(checkStockPromises).then((results) => {
    for (let i = 0; i < results.length; i++) {
      const [rows] = results[i];
      if (rows.length === 0 || rows[0].stock < details[i].quantity) {
        return res
          .status(400)
          .send(
            `No hay stock suficiente para el producto con ID ${details[i].product_id}`
          );
      }
    }
  });
});

app.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/api/products`);
});
