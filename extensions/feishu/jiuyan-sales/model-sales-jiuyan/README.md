# Model Sales Jiuyan

Sales forecasting model for the Jiuyan project.

## Overview

This project implements a 12-month sales forecasting model at the SKU level using a Global LightGBM approach. It utilizes historical sales data, SKU attributes, and holiday effects (e.g., Chinese New Year) to provide accurate predictions.

## Project Structure

- `forecasting/`: Core forecasting logic, including data preparation, feature engineering, model training, and evaluation.
- `docs/`: Documentation for database structure, SKU analysis, and regional data.
- `outputs/`: Forecast results and visualizations.
- `implementations/`: Implementation plans and technical details.

## Key Features

- **Global LightGBM Model**: Trained across all SKUs for robust forecasting.
- **Feature Engineering**: Includes time-series features, SKU attributes, and holiday flags.
- **Evaluation**: Comprehensive metrics and visualization of forecast trends.

## Getting Started

1. Ensure requirements are installed.
2. Configure settings in `forecasting/config.py`.
3. Run `forecasting/train.py` to train the model.
4. Run `forecasting/evaluate.py` to generate forecasts and visualizations.

## Documentation

For more details, see the files in the `docs/` directory.
