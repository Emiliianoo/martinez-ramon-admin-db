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
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

app.post("/api/purchases", async (req, res) => {
  const { user_id, status, details } = req.body;

  // Validaciones básicas
  if (!isPositiveInt(Number(user_id))) {
    return res
      .status(400)
      .send("user_id es requerido y debe ser entero positivo");
  }
  if (typeof status !== "string" || !status.trim()) {
    return res.status(400).send("status es requerido");
  }
  if (!Array.isArray(details) || details.length < 1) {
    return res.status(400).send("Debe haber al menos un producto en la compra");
  }
  if (details.length > 5) {
    return res
      .status(400)
      .send("No se pueden comprar más de 5 productos por compra");
  }

  // Validación por item
  for (const it of details) {
    if (!isPositiveInt(Number(it?.product_id))) {
      return res.status(400).send("product_id inválido");
    }
    if (!isPositiveInt(Number(it?.quantity))) {
      return res.status(400).send("quantity debe ser entero > 0");
    }
    if (typeof it?.price !== "number" || !(it.price > 0)) {
      return res.status(400).send("price debe ser número > 0");
    }
  }

  // El total de la compra no puede pasar la cantidad de $3500
  const totalAmount = details.reduce(
    (total, item) => total + item.price * item.quantity,
    0
  );

  if (totalAmount > 3500) {
    return res
      .status(400)
      .send("El total de la compra no puede exceder los $3500");
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Validar que haya stock disponible en cada producto
    for (const item of details) {
      const [rows] = await conn.query(
        "SELECT id, stock FROM products WHERE id = ? FOR UPDATE",
        [item.product_id]
      );
      if (rows.length === 0) {
        await conn.rollback();
        return res
          .status(400)
          .send(`Producto con ID ${item.product_id} no encontrado`);
      }
      if (rows[0].stock < item.quantity) {
        await conn.rollback();
        return res
          .status(400)
          .send(
            `No hay suficiente stock para el producto con ID ${item.product_id}`
          );
      }
    }

    // Insertar la compra
    const [purchaseResult] = await conn.query(
      "INSERT INTO purchases (user_id, total, status, purchase_date) VALUES (?, ?, ?, NOW())",
      [user_id, totalAmount, status.trim()]
    );
    const purchaseId = purchaseResult.insertId;

    // Insertar los detalles de la compra y actualizar stock
    for (const item of details) {
      const subtotal = item.price * item.quantity;

      await conn.query(
        "INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)",
        [purchaseId, item.product_id, item.quantity, item.price, subtotal]
      );

      await conn.query("UPDATE products SET stock = stock - ? WHERE id = ?", [
        item.quantity,
        item.product_id,
      ]);
    }

    await conn.commit();

    return res.status(201).json({
      purchase_id: purchaseId,
      user_id,
      total: totalAmount,
      status,
      details,
    });
  } catch (error) {
    console.error(error);
    try {
      await conn.rollback();
    } catch (_) {}
    return res.status(500).send("Error al procesar la compra");
  } finally {
    conn.release();
  }
});

// Actualizar una compra existente y sus detalles
app.put("/api/purchases/:id", async (req, res) => {
  if (!isPositiveInt(Number(req.params.id))) {
    return res.status(400).send("ID de compra inválido");
  }

  const { user_id, status, details } = req.body;

  // Validaciones básicas
  if (!isPositiveInt(Number(user_id))) {
    return res
      .status(400)
      .send("user_id es requerido y debe ser entero positivo");
  }
  if (typeof status !== "string" || !status.trim()) {
    return res.status(400).send("status es requerido");
  }
  if (!Array.isArray(details) || details.length < 1) {
    return res.status(400).send("Debe haber al menos un producto en la compra");
  }
  if (details.length > 5) {
    return res
      .status(400)
      .send("No se pueden comprar más de 5 productos por compra");
  }
  // Status no puede ser 'completed'
  if (status.trim().toLowerCase() === "completed") {
    return res
      .status(400)
      .send("No se puede actualizar una compra a 'completed'");
  }

  // Validación por item
  for (const it of details) {
    if (!isPositiveInt(Number(it?.product_id))) {
      return res.status(400).send("product_id inválido");
    }
    if (!isPositiveInt(Number(it?.quantity))) {
      return res.status(400).send("quantity debe ser entero > 0");
    }
    if (typeof it?.price !== "number" || !(it.price > 0)) {
      return res.status(400).send("price debe ser número > 0");
    }
  }

  // El total de la compra no puede pasar la cantidad de $3500
  const totalAmount = details.reduce(
    (total, item) => total + item.price * item.quantity,
    0
  );

  // redondear a dos decimales
  const roundedTotal = Math.round((totalAmount + Number.EPSILON) * 100) / 100;

  if (roundedTotal > 3500) {
    return res
      .status(400)
      .send("El total de la compra no puede exceder los $3500");
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Verificar si la compra existe
    const [purchaseRows] = await conn.query(
      "SELECT * FROM purchases WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (purchaseRows.length === 0) {
      // Crear la compra si no existe

      // Verificar stock de cada producto
      for (const item of details) {
        const [rows] = await conn.query(
          "SELECT id, stock FROM products WHERE id = ? FOR UPDATE",
          [item.product_id]
        );
        if (rows.length == 0) {
          await conn.rollback();
          return res
            .status(400)
            .send(`Producto con ID ${item.product_id} no encontrado`);
        }
        if (rows[0].stock < item.quantity) {
          await conn.rollback();
          return res
            .status(400)
            .send(
              `No hay suficiente stock para el producto con ID ${item.product_id}`
            );
        }
      }

      // Insertar la compra
      await conn.query(
        "INSERT INTO purchases (id, user_id, total, status, purchase_date) VALUES (?, ?, ?, ?, NOW())",
        [req.params.id, user_id, roundedTotal, status.trim()]
      );

      // Insertar los detalles de la compra y actualizar stock
      for (const item of details) {
        const subtotal = item.price * item.quantity;

        await conn.query(
          "INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)",
          [req.params.id, item.product_id, item.quantity, item.price, subtotal]
        );

        await conn.query("UPDATE products SET stock = stock - ? WHERE id = ?", [
          item.quantity,
          item.product_id,
        ]);
      }

      await conn.commit();

      return res.status(201).json({
        purchase_id: Number(req.params.id),
        user_id,
        total: roundedTotal,
        status,
        details,
      });
    }
  } catch (error) {
    console.error(error);
  } finally {
    conn.release();
  }
});

app.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/api/products`);
});
