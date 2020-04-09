#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Apr  7 21:07:56 2020

@author: fraifeld-mba
"""

import requests
from bs4 import BeautifulSoup
import pandas as pd
from matplotlib import pyplot as plt
from sklearn.linear_model import LinearRegression

df = pd.read_csv("covid/sdgrades.csv")

## Convert grades to numbers

grade_dict = {grade:i+1 for i,grade in enumerate(df.Grade.unique()[::-1])}
grades = [x.strip() for x in df.Grade.unique()]
for g in grades:
    df.Grade=df.Grade.replace(g,grade_dict[g])
    
education = pd.read_csv("covid/EducationReport.csv")

df = df.merge(education)


lm = LinearRegression()
x = (df.Percent_College_Graduate*100).values.reshape(-1,1)
y = df.Grade.values.reshape(-1,1)
lm.fit(X=x,y=y)
y_pred = lm.predict(x)

plt.scatter(x,y)
plt.plot(x,y_pred,color='red')
plt.title("Education and Social Distancing by US State")
plt.xlabel("Percent Graduated College")
plt.yticks(list(range(8,0,-1)),grades)
plt.ylabel("Unacast Social Distancing Grade")
plt.show()