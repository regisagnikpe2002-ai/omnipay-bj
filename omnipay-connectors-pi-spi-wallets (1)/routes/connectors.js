"use strict";
const router=require("express").Router();
const c=require("../controllers/connectorsController");
router.get("/",c.list);
router.get("/:provider/health",c.health);
module.exports=router;
